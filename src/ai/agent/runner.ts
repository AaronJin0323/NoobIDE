import { randomBytes, randomUUID } from 'node:crypto';
import type { AiEvent, AiFileChange, AiProposalDecision, AiRequest } from '../../shared/ipc/ai-contract';
import { errorMessage } from './messages';
import type { ModelPort } from './model-port';
import { runAgentLoop, type AgentAiRequest, type AgentBudgets, type DecisionResults } from './loop';
import type { AgentProjectPorts } from './tools';

/**
 * The entry point S31's AI service calls for a request of kind `agent` (S34.1).
 *
 * ```ts
 * const agentRunner = createAgentRunner({ projectPorts: (projectId) => createProjectPorts({ … }) });
 * const run = agentRunner({ requestId, request, model }, (event) => send(event), abortController.signal);
 * // ai:resolve-proposal → run.resolveProposal(decision) (false → reply 'unknown-request')
 * // ai:cancel            → abortController.abort()
 * await run.finished;     // the run emitted exactly one terminal event ('done' or 'error', 'cancelled' on abort)
 * ```
 *
 * The service checks AI is enabled, the key, and the project's consent before calling; it owns the request id, the
 * provider and model choice (it passes a {@link ModelPort} for the agent model) and logging (ids, token counts, error
 * codes — never content). The runner emits every event of the request, including the terminal one; the service must
 * not emit another terminal event for it.
 */
export interface AgentRunInput {
  readonly requestId: string;
  /** Must be of kind 'agent' (anything else ends with `provider-error`). */
  readonly request: AiRequest;
  readonly model: ModelPort;
  readonly budgets?: Partial<AgentBudgets>;
}

export interface AgentRun {
  /** Settles (never rejects) after the terminal event was emitted. */
  readonly finished: Promise<void>;
  /**
   * The workbench's decision on a proposal of this run. False when it does not match the proposal the run is waiting
   * for (wrong ids, wrong number of results, already resolved, run finished) — the decision is then ignored.
   */
  resolveProposal(decision: AiProposalDecision): boolean;
}

export type AgentRunner = (input: AgentRunInput, emit: (event: AiEvent) => void, signal: AbortSignal) => AgentRun;

export interface AgentRunnerDeps {
  /** Ports onto the open project's existing services, or null when that project is not open (tools.ts). */
  projectPorts(projectId: string): AgentProjectPorts | null;
  readonly budgets?: Partial<AgentBudgets>;
  readonly newId?: () => string;
  readonly now?: () => number;
}

interface Waiting {
  readonly proposalId: string;
  readonly count: number;
  readonly resolve: (results: DecisionResults | null) => void;
}

export function createAgentRunner(deps: AgentRunnerDeps): AgentRunner {
  return (input, emitEvent, signal) => {
    let waiting: Waiting | null = null;
    let ended = false;
    const locale = input.request.kind === 'agent' && input.request.locale === 'en' ? 'en' : 'zh-CN';
    // At most one terminal event reaches the service, whatever happens below.
    const emit = (event: AiEvent) => {
      if (ended) return;
      if (event.type === 'done' || event.type === 'error') ended = true;
      emitEvent(event);
    };
    let finishedFlag = false;
    const onAbort = () => {
      waiting?.resolve(null);
      waiting = null;
    };
    signal.addEventListener('abort', onAbort);

    const awaitDecision = (proposalId: string, changes: readonly AiFileChange[]) =>
      new Promise<DecisionResults | null>((resolve) => {
        if (signal.aborted) return resolve(null);
        waiting = { proposalId, count: changes.length, resolve };
      });

    const run = async (): Promise<void> => {
      const request = input.request;
      if (request.kind !== 'agent') {
        emit({
          requestId: input.requestId,
          type: 'error',
          code: 'provider-error',
          message: errorMessage(locale, 'provider-error'),
        });
        return;
      }
      const ports = deps.projectPorts(request.projectId);
      if (!ports) {
        emit({
          requestId: input.requestId,
          type: 'error',
          code: 'unknown-project',
          message: errorMessage(locale, 'unknown-project'),
        });
        return;
      }
      await runAgentLoop({
        requestId: input.requestId,
        request: request as AgentAiRequest,
        model: input.model,
        ports,
        emit,
        signal,
        budgets: { ...deps.budgets, ...input.budgets },
        awaitDecision,
        newId: deps.newId ?? randomUUID,
        nonce: randomBytes(6).toString('hex'),
        ...(deps.now ? { now: deps.now } : {}),
      });
    };

    const finished = run()
      .catch(() => {
        // runAgentLoop never throws; a failure before it started is reported here.
        emit({
          requestId: input.requestId,
          type: 'error',
          code: 'provider-error',
          message: errorMessage(locale, 'provider-error'),
        });
      })
      .finally(() => {
        finishedFlag = true;
        signal.removeEventListener('abort', onAbort);
        waiting?.resolve(null);
        waiting = null;
      });

    return {
      finished,
      resolveProposal(decision) {
        const current = waiting;
        if (finishedFlag || !current || !isDecisionFor(decision, input.requestId, current)) return false;
        waiting = null;
        current.resolve(decision.results);
        return true;
      },
    };
  };
}

function isDecisionFor(decision: AiProposalDecision, requestId: string, waiting: Waiting): boolean {
  if (decision.requestId !== requestId || decision.proposalId !== waiting.proposalId) return false;
  if (!Array.isArray(decision.results) || decision.results.length !== waiting.count) return false;
  return decision.results.every((r: unknown) => {
    if (typeof r !== 'object' || r === null) return false;
    const result = r as Record<string, unknown>;
    if (result.accepted === false) return Object.keys(result).length === 1;
    if (result.accepted !== true || typeof result.applied !== 'boolean') return false;
    return result.error === undefined || typeof result.error === 'string';
  });
}
