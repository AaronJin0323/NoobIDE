import type {
  AiContextItem,
  AiErrorCode,
  AiEvent,
  AiFileChange,
  AiProposalDecision,
  AiRequest,
} from '../../shared/ipc/ai-contract';
import { cutOffNote, errorMessage, failedStepSummary, stepSummary, type AgentLocale, type StepKey } from './messages';
import {
  ModelPortError,
  type AgentContentBlock,
  type AgentImage,
  type AgentMessage,
  type ModelPort,
  type ModelStopReason,
} from './model-port';
import { neutralizeData } from '../prompts';
import { agentSystemPrompt } from './prompt';
import { validateToolInput } from './tool-schema';
import {
  AGENT_TOOLS,
  LIMITS,
  PROPOSAL_TOOLS,
  READ_TOOLS,
  checkAgentPath,
  checkProposal,
  frameData,
  runReadTool,
  touchedPaths,
  type AgentProjectPorts,
  type ToolOutcome,
} from './tools';

/**
 * The agent's manual tool-use loop (S34.1, decision 0025). Main process only.
 *
 * One turn: call the model → stream its text to the workbench → run the read-only tools it asked for (all results of
 * one step go back in ONE message, in call order) → if it proposed file changes, emit ONE `proposal` event for all of
 * that step's proposals and wait for the user's decision → answer each proposal call with the outcome → repeat until
 * the model ends its turn. The loop never writes files; only the user's decision (from the workbench via
 * `resolveProposal`) can mark a change accepted, so nothing the model writes — or a file it reads — can approve one.
 *
 * Budgets per turn: model calls (steps), tokens (input + output over all calls), and wall time spent working (the
 * time waiting for the user's decision does not count). Stop (the signal) ends the turn at once. Exactly one terminal
 * event (`done` or `error`) is emitted.
 */

export type AgentAiRequest = Extract<AiRequest, { kind: 'agent' }>;
export type DecisionResults = AiProposalDecision['results'];

export interface AgentBudgets {
  readonly maxSteps: number;
  /** Input + output tokens over all model calls of the turn. */
  readonly maxTokens: number;
  /** Working time of the turn (excluding the wait for the user's decisions). */
  readonly maxWallTimeMs: number;
  readonly maxOutputTokensPerStep: number;
}

export const DEFAULT_AGENT_BUDGETS: AgentBudgets = {
  maxSteps: 30,
  maxTokens: 1_500_000,
  maxWallTimeMs: 15 * 60_000,
  maxOutputTokensPerStep: 32_000,
};

/** Text the user attached as context, at most (characters). */
export const MAX_CONTEXT_CHARS = 200_000;

export interface AgentLoopOptions {
  readonly requestId: string;
  readonly request: AgentAiRequest;
  readonly model: ModelPort;
  readonly ports: AgentProjectPorts;
  readonly emit: (event: AiEvent) => void;
  readonly signal: AbortSignal;
  readonly budgets?: Partial<AgentBudgets>;
  /**
   * Resolves with the user's decision for a proposal (one result per change, in order), or null when the turn was
   * stopped while waiting.
   */
  readonly awaitDecision: (proposalId: string, changes: readonly AiFileChange[]) => Promise<DecisionResults | null>;
  readonly newId: () => string;
  /** Random per run; marks data frames in tool results. */
  readonly nonce: string;
  /** S38.2: screenshots of attached Preview items (sent only when the model accepts images). */
  readonly contextImages?: readonly AgentImage[];
  readonly now?: () => number;
}

class BudgetExhausted extends Error {}

interface PendingProposal {
  readonly toolUseId: string;
  readonly index: number;
  readonly change: AiFileChange;
}

export async function runAgentLoop(options: AgentLoopOptions): Promise<void> {
  const { requestId, request, model, ports, signal } = options;
  const locale: AgentLocale = request.locale === 'en' ? 'en' : 'zh-CN';
  const budgets: AgentBudgets = { ...DEFAULT_AGENT_BUDGETS, ...options.budgets };
  const now = options.now ?? Date.now;
  let terminal = false;
  const emit = (event: AiEvent) => {
    if (!terminal) options.emit(event);
  };
  const finish = (event: AiEvent) => {
    if (terminal) return;
    terminal = true; // before emitting: a throwing listener cannot cause a second terminal event
    options.emit(event);
  };
  const fail = (code: AiErrorCode, http?: { status?: number; retryAfterSeconds?: number }) =>
    finish({ requestId, type: 'error', code, message: errorMessage(locale, code), ...http });
  const usage = { inputTokens: 0, outputTokens: 0 };
  let workedMs = 0;
  let textEmitted = false;
  /** S38.2: screenshots this turn may still send. */
  const screenshots = { left: LIMITS.screenshots };

  try {
    const images = model.acceptsImages ? (options.contextImages ?? []) : [];
    const first = await firstUserMessage(request, ports, options.nonce, images);
    if (first === null) return fail('context-too-large');
    const messages: AgentMessage[] = [...historyMessages(request), first];
    const system = agentSystemPrompt(locale);

    for (let step = 1; ; step += 1) {
      if (signal.aborted) return fail('cancelled');
      if (step > budgets.maxSteps) throw new BudgetExhausted();
      if (usage.inputTokens + usage.outputTokens >= budgets.maxTokens) throw new BudgetExhausted();
      const remainingMs = budgets.maxWallTimeMs - workedMs;
      if (remainingMs <= 0) throw new BudgetExhausted();

      // ── one model call ──
      const started = now();
      const call = new AbortController();
      const onAbort = () => call.abort();
      signal.addEventListener('abort', onAbort);
      let overBudget = false;
      const timer = setTimeout(() => {
        overBudget = true;
        call.abort();
      }, remainingMs);
      let stopReason: ModelStopReason = 'other';
      let content: readonly AgentContentBlock[] = [];
      let callUsage = { inputTokens: 0, outputTokens: 0 };
      let separated = false;
      try {
        for await (const event of model.streamTurn({
          system,
          messages,
          tools: AGENT_TOOLS,
          maxOutputTokens: budgets.maxOutputTokensPerStep,
          signal: call.signal,
        })) {
          if (call.signal.aborted) break;
          if (event.type === 'text') {
            if (event.text === '') continue;
            if (textEmitted && !separated) emit({ requestId, type: 'text', text: '\n\n' });
            separated = true;
            textEmitted = true;
            emit({ requestId, type: 'text', text: event.text });
          } else if (event.type === 'usage') {
            callUsage = { inputTokens: event.inputTokens, outputTokens: event.outputTokens };
            const spent = usage.inputTokens + usage.outputTokens + callUsage.inputTokens + callUsage.outputTokens;
            if (spent > budgets.maxTokens) {
              overBudget = true;
              call.abort();
            }
          } else {
            stopReason = event.stopReason;
            content = event.content;
          }
        }
      } catch (e) {
        if (!call.signal.aborted) throw e;
      } finally {
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        workedMs += now() - started;
        usage.inputTokens += callUsage.inputTokens;
        usage.outputTokens += callUsage.outputTokens;
      }
      if (signal.aborted) return fail('cancelled');
      if (overBudget) throw new BudgetExhausted();
      if (stopReason === 'refusal') return fail('refused'); // its tool calls (maybe cut off) are never run

      messages.push({ role: 'assistant', content }); // exactly as returned (opaque provider blocks included)
      const calls = content.filter((b): b is Extract<AgentContentBlock, { type: 'tool_use' }> => b.type === 'tool_use');
      if (calls.length === 0) {
        if (stopReason === 'pause_turn') continue;
        // An answer cut off at the output limit is said to be cut off, not presented as complete.
        if (stopReason === 'max_tokens') emit({ requestId, type: 'text', text: `\n\n${cutOffNote(locale)}` });
        return finish({ requestId, type: 'done', usage: { ...usage } });
      }

      // ── run the step's tools ──
      const results = new Map<string, ToolOutcome>();
      if (stopReason === 'max_tokens') {
        // The output was cut off: a tool input may be incomplete even if it parses, so nothing is run.
        for (const c of calls) {
          results.set(c.id, {
            isError: true,
            content:
              'Your output was cut off, so this tool input may be incomplete and the tool was not run. Use smaller steps (for example propose_edit with old_text/new_text).',
          });
        }
      } else {
        const pending: PendingProposal[] = [];
        const touched = new Set<string>();
        const reasons: string[] = [];
        const workStarted = now();
        // Read tools run concurrently; their steps are shown in call order.
        const ran = await Promise.all(calls.map((c) => runCall(c, locale)));
        calls.forEach((c, i) => {
          const r = ran[i];
          if (!r) return;
          results.set(c.id, r.outcome);
          if (r.step) emit(r.step);
        });
        // Proposals are checked in call order (so "one change per file" is deterministic).
        for (const c of calls) {
          if (!PROPOSAL_TOOLS.includes(c.name) || results.has(c.id)) continue;
          const checked = await checkProposal(c.name, c.input as Record<string, unknown>, ports);
          if (!checked.ok) {
            results.set(c.id, { isError: true, content: checked.error });
            const input = c.input as Record<string, unknown>;
            const target = typeof input.path === 'string' ? input.path.slice(0, 80) : c.name;
            emit({ requestId, type: 'step', tool: c.name, summary: stepSummary(locale, 'refused', target) });
            continue;
          }
          const paths = touchedPaths(checked.change);
          if (paths.some((p) => touched.has(p))) {
            results.set(c.id, {
              isError: true,
              content:
                'Another proposal in this step already changes this path. Propose one change per file per step (put several edits into one content).',
            });
            continue;
          }
          for (const p of paths) touched.add(p);
          pending.push({ toolUseId: c.id, index: pending.length, change: checked.change });
          if (checked.reason && !reasons.includes(checked.reason)) reasons.push(checked.reason);
        }
        workedMs += now() - workStarted;
        if (signal.aborted) return fail('cancelled');

        if (pending.length > 0) {
          const proposalId = options.newId();
          const changes = pending.map((p) => p.change);
          emit({ requestId, type: 'proposal', proposalId, changes, reason: reasons.join(' ') });
          const decision = await options.awaitDecision(proposalId, changes);
          if (decision === null || signal.aborted) return fail('cancelled');
          for (const p of pending) results.set(p.toolUseId, outcomeText(decision[p.index], p.change, options.nonce));
        }
      }
      messages.push({
        role: 'user',
        content: calls.map((c) => {
          const r = results.get(c.id) ?? { isError: true, content: 'The tool was not run.' };
          return {
            type: 'tool_result',
            toolUseId: c.id,
            content: r.content,
            isError: r.isError,
            ...(r.images && r.images.length > 0 && model.acceptsImages ? { images: r.images } : {}),
          };
        }),
      });
    }
  } catch (e) {
    if (signal.aborted) return fail('cancelled');
    if (e instanceof BudgetExhausted) return fail('budget-exhausted');
    if (e instanceof ModelPortError) {
      return fail(e.code, {
        ...(e.status !== undefined ? { status: e.status } : {}),
        ...(e.retryAfterSeconds !== undefined ? { retryAfterSeconds: e.retryAfterSeconds } : {}),
      });
    }
    return fail('provider-error');
  } finally {
    // Guarantees exactly one terminal event even if a branch above returned without one.
    if (!terminal) fail(signal.aborted ? 'cancelled' : 'provider-error');
  }

  /** Validates a call and runs it if it is a read tool; returns undefined for valid proposal calls (checked later). */
  async function runCall(
    c: Extract<AgentContentBlock, { type: 'tool_use' }>,
    loc: AgentLocale,
  ): Promise<{ outcome: ToolOutcome; step?: AiEvent } | undefined> {
    const refuse = (content: string) => ({ outcome: { isError: true, content } });
    const definition = AGENT_TOOLS.find((t) => t.name === c.name);
    if (!definition) return refuse(`Unknown tool "${c.name}". Use only the tools you were given.`);
    if (c.inputError !== undefined) return refuse(JSON.stringify({ INVALID_JSON: c.inputError.slice(0, 2000) }));
    const invalid = validateToolInput(definition.inputSchema, c.input);
    if (invalid) return refuse(`Invalid input: ${invalid}.`);
    if (!READ_TOOLS.includes(c.name)) return undefined;
    const input = c.input as Record<string, unknown>;
    let outcome: ToolOutcome;
    try {
      outcome = await runReadTool(c.name, input, {
        ports,
        nonce: options.nonce,
        signal,
        acceptsImages: model.acceptsImages === true,
        screenshots,
      });
    } catch {
      outcome = { isError: true, content: 'The tool failed unexpectedly.' };
    }
    const target = typeof input.path === 'string' ? input.path : typeof input.query === 'string' ? input.query : '';
    const shown = target.length > 80 ? `${target.slice(0, 80)}…` : target;
    const summary = outcome.isError
      ? failedStepSummary(loc, c.name, shown)
      : stepSummary(loc, c.name as StepKey, shown);
    return { outcome, step: { requestId, type: 'step', tool: c.name, summary } };
  }
}

function describeChange(change: AiFileChange): string {
  switch (change.kind) {
    case 'edit':
      return `edit of ${change.relPath}`;
    case 'create':
      return `new file ${change.relPath}`;
    case 'rename':
      return `rename of ${change.relPath} to ${change.to}`;
    case 'delete':
      return `${change.relPath} moved to the trash`;
  }
}

/** What the model learns about one proposed change. The workbench's error text is framed as data. */
function outcomeText(result: DecisionResults[number] | undefined, change: AiFileChange, nonce: string): ToolOutcome {
  const what = describeChange(change);
  if (!result || !result.accepted) {
    return {
      isError: false,
      content: `The user REJECTED this change (${what}); it was not applied. Do not propose it again unless the user asks for it; you may ask what they would prefer.`,
    };
  }
  if (result.applied) {
    return { isError: false, content: `The user accepted this change (${what}) and it has been applied and saved.` };
  }
  const detail = result.error
    ? `\n${frameData(nonce, 'kind="apply-error"', result.error.slice(0, LIMITS.messageChars))}`
    : '';
  return {
    isError: true,
    content: `The user accepted this change (${what}), but applying it did not complete; the details say what happened.${detail}`,
  };
}

function historyMessages(request: AgentAiRequest): AgentMessage[] {
  const out: AgentMessage[] = [];
  for (const m of request.history) {
    if (m.text === '' || (out.length === 0 && m.role !== 'user')) continue; // a conversation starts with the user
    out.push({ role: m.role, content: [{ type: 'text', text: m.text }] });
  }
  // Consecutive user messages are allowed by both providers (they are read as one turn); nothing is invented.
  return out;
}

/** The user's prompt plus the context items they saw, each framed as data. Null when the context is too large. */
async function firstUserMessage(
  request: AgentAiRequest,
  ports: AgentProjectPorts,
  nonce: string,
  images: readonly AgentImage[],
): Promise<AgentMessage | null> {
  const blocks: AgentContentBlock[] = [];
  let size = 0;
  for (const item of request.context) {
    const text = await contextText(item, ports);
    if (text === null) continue;
    size += text.length;
    if (size > MAX_CONTEXT_CHARS) return null;
    const attributes = [`context=${JSON.stringify(item.kind)}`];
    if (item.relPath) attributes.push(`path=${JSON.stringify(item.relPath)}`);
    if (item.startLine) attributes.push(`lines="${item.startLine}-${item.endLine ?? item.startLine}"`);
    if (item.label) attributes.push(`label=${JSON.stringify(item.label.slice(0, 200))}`);
    // Page text (S38.2, and an annotation's element text, S41.6) can be anything a webpage shows: it cannot close
    // the chat's framing tags either.
    const body = item.kind === 'preview' || item.kind === 'annotation' ? neutralizeData(text) : text;
    blocks.push({ type: 'text', text: frameData(nonce, attributes.join(' '), body) });
  }
  for (const image of images) blocks.push({ type: 'image', mediaType: image.mediaType, data: image.data });
  blocks.push({ type: 'text', text: request.prompt });
  return { role: 'user', content: blocks };
}

async function contextText(item: AiContextItem, ports: AgentProjectPorts): Promise<string | null> {
  if (typeof item.text === 'string') return item.text;
  if (item.kind !== 'file' || !item.relPath) return item.label ?? null;
  const checked = checkAgentPath(item.relPath);
  if (!checked.ok) return null;
  const read = await ports.readFile(checked.relPath);
  return read.ok && !read.value.readOnly ? read.value.text : null;
}
