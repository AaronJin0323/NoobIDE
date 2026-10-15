import { randomUUID } from 'node:crypto';
import {
  type AiConfig,
  type AiErrorCode,
  type AiEvent,
  type AiKeyError,
  type AiModelInfo,
  type AiProposalDecision,
  type AiProviderId,
  type AiPurpose,
  type AiRequest,
  type AiStatus,
  type AiTestError,
} from '../shared/ipc/ai-contract';
import { err, ok, type Result } from '../shared/result';
import type { AiConfigStore, AiConsentStore } from './config-store';
import type { AiUsageStore } from './usage-store';
import type { KeyStore } from './keys';
import type { ModelPort } from './agent/model-port';
import type { AgentRun, AgentRunner } from './agent/runner';
import { toModelPort } from './providers/model-port-adapter';
import {
  chatSystemPrompt,
  chatUserMessage,
  contextBlock,
  editSystemPrompt,
  editUserMessage,
  historyMessages,
  inlineSystemPrompt,
  inlineUserMessage,
  stripCodeFence,
  type ChatMode,
} from './prompts';
import {
  ANTHROPIC_DEFAULT_MODELS,
  pickOpenAiDefaults,
  ProviderError,
  type AiProvider,
  type ProviderEffort,
  type ProviderErrorCode,
  type ProviderFactory,
  type ProviderMessage,
  type ProviderUsage,
} from './providers/provider';

/**
 * The AI request service in main (S31.3, decision 0025): status, keys, config, consent and the request lifecycle.
 *
 * - A request carrying project code (inline, edit, agent; chat with context from a project) is refused with
 *   `no-consent` until the user allowed that project; consent is revocable.
 * - Requests stream AiEvents to the window that started them, can be cancelled (by that window, or when it closes),
 *   have per-purpose output-token and wall-time budgets, and map provider failures to AiErrorCode with a short
 *   technical message (the UI explains each code in the user's language).
 * - The log gets only request id, purpose, provider, model, token counts, duration and result code — never prompts,
 *   code, responses or keys (AGENTS.md).
 * - Agent requests run in S34's injected `agentRunner` (src/ai/agent/runner.ts) with a ModelPort over the active
 *   provider (providers/model-port-adapter.ts, or `agentModel` — the fake's ScriptedModel); the runner emits every
 *   event of the request including the single terminal one, the service only logs it. Without a runner they fail
 *   with 'provider-error' / 'agent not available'.
 */

/** S34's runner (src/ai/agent/runner.ts) builds a ModelPort per agent request from the active provider. */
export type AgentModelFactory = (providerId: AiProviderId, provider: AiProvider, model: string) => ModelPort;

export type AiLog = (
  level: 'info' | 'warn' | 'error',
  event: string,
  fields: Readonly<Record<string, string | number | boolean>>,
) => void;

export interface AiServiceDeps {
  readonly keys: Pick<KeyStore, 'stored' | 'get' | 'set' | 'clear' | 'secureStorageAvailable'>;
  readonly config: AiConfigStore;
  readonly consent: AiConsentStore;
  readonly providers: ProviderFactory;
  /** Real root of an open project (main only), or undefined. */
  rootOf(projectId: string): string | undefined;
  /** A project file's text, for context items sent without text. */
  readFile(projectId: string, relPath: string): Promise<string | null>;
  readonly agentRunner?: AgentRunner;
  /** Overrides how the agent's ModelPort is built (fake mode: a ScriptedModel). Default: toModelPort(provider). */
  readonly agentModel?: AgentModelFactory;
  readonly log?: AiLog;
  /**
   * S39.2: token use per day and provider, and the optional daily budget. When the budget is reached, NEW requests are
   * refused with 'budget-reached' (running ones finish; their tokens still count).
   */
  readonly usage?: Pick<AiUsageStore, 'record' | 'budgetReached'>;
  readonly now?: () => number;
  /** For tests: shorter budgets. */
  readonly budgets?: Partial<Record<AiPurpose, AiBudget>>;
}

export interface AiBudget {
  readonly maxOutputTokens: number;
  readonly timeoutMs: number;
  readonly effort: ProviderEffort;
}

/** Per-purpose budgets: output tokens, wall time, effort. */
export const AI_BUDGETS: Readonly<Record<AiPurpose, AiBudget>> = {
  chat: { maxOutputTokens: 16_000, timeoutMs: 5 * 60_000, effort: 'medium' },
  edit: { maxOutputTokens: 16_000, timeoutMs: 3 * 60_000, effort: 'medium' },
  inline: { maxOutputTokens: 256, timeoutMs: 20_000, effort: 'low' },
  agent: { maxOutputTokens: 32_000, timeoutMs: 15 * 60_000, effort: 'high' },
};

/**
 * Agent turns: the loop's own wall-time budget (AI_BUDGETS.agent.timeoutMs) counts working time only, not the wait for
 * the user's decision on a proposal. This backstop ends a turn whose proposal was never decided (S36.1).
 */
export const AGENT_BACKSTOP_MS = 2 * 60 * 60_000;

/** Total characters of project context one request may send (~100k tokens). */
export const MAX_CONTEXT_CHARS = 400_000;

interface Running {
  readonly owner: number;
  readonly kind: AiPurpose;
  /** What the request uses, so revoking consent, switching AI off or removing the key stops it (S36.1). */
  readonly projectId: string | null;
  readonly provider: AiProviderId;
  readonly controller: AbortController;
  /** The agent run (S34), once started: proposal decisions go to it. */
  agent: AgentRun | null;
  cancelled: boolean;
  timedOut: boolean;
}

export type AiSink = (event: AiEvent) => void;

const TEST_ERRORS: Readonly<Partial<Record<ProviderErrorCode, AiTestError>>> = {
  unauthorized: 'unauthorized',
  'rate-limited': 'rate-limited',
  offline: 'offline',
  'model-not-found': 'model-not-found',
};

const REQUEST_ERRORS: Readonly<Partial<Record<ProviderErrorCode, AiErrorCode>>> = {
  unauthorized: 'unauthorized',
  'rate-limited': 'rate-limited',
  offline: 'offline',
  'context-too-large': 'context-too-large',
  cancelled: 'cancelled',
};

export class AiService {
  private readonly running = new Map<string, Running>();
  constructor(private readonly deps: AiServiceDeps) {}

  // --- status, keys, config, consent ---

  async status(projectId: string | null): Promise<AiStatus> {
    const [config, keyStored] = await Promise.all([this.deps.config.get(), this.deps.keys.stored()]);
    const root = projectId ? this.deps.rootOf(projectId) : undefined;
    return {
      config,
      keyStored,
      secureStorage: this.deps.keys.secureStorageAvailable(),
      projectConsent: root !== undefined && (await this.deps.consent.isAllowed(root)),
      ...(this.deps.usage ? { budgetReached: await this.deps.usage.budgetReached() } : {}),
    };
  }

  async setKey(provider: AiProviderId, key: string): Promise<Result<null, AiKeyError>> {
    const result = await this.deps.keys.set(provider, key);
    if (result.ok) await this.deps.config.adoptProvider(provider);
    return result;
  }

  async clearKey(provider: AiProviderId): Promise<Result<null, AiKeyError>> {
    // Requests already using the key stop with it (S36.1).
    for (const run of this.running.values()) if (run.provider === provider) this.abort(run);
    return this.deps.keys.clear(provider);
  }

  async testKey(provider: AiProviderId): Promise<Result<null, AiTestError>> {
    const client = await this.provider(provider);
    if (!client) return err('no-key', 'no key stored');
    const started = this.now();
    try {
      await client.test(AbortSignal.timeout(30_000));
      this.log('info', 'ai-key-test', { provider, result: 'ok', ms: this.now() - started });
      return ok(null);
    } catch (e) {
      const code = testErrorOf(e);
      this.log('warn', 'ai-key-test', { provider, result: code, ms: this.now() - started });
      return err(code, providerMessage(e));
    }
  }

  async listModels(provider: AiProviderId): Promise<Result<readonly AiModelInfo[], AiTestError>> {
    const client = await this.provider(provider);
    if (!client) return err('no-key', 'no key stored');
    try {
      return ok(await client.listModels(AbortSignal.timeout(30_000)));
    } catch (e) {
      const code = testErrorOf(e);
      this.log('warn', 'ai-list-models', { provider, result: code });
      return err(code, providerMessage(e));
    }
  }

  async setConfig(config: AiConfig): Promise<AiConfig> {
    this.log('info', 'ai-config', {
      enabled: config.enabled,
      provider: config.provider ?? 'none',
      inline: config.inlineCompletions,
    });
    const next = await this.deps.config.set(config);
    // Switching AI (or inline completions, or the provider) off stops what is running, not just what comes next.
    for (const run of this.running.values()) {
      if (!next.enabled || next.provider !== run.provider || (run.kind === 'inline' && !next.inlineCompletions)) {
        this.abort(run);
      }
    }
    return next;
  }

  async setConsent(projectId: string, allowed: boolean): Promise<Result<null, 'unknown-project'>> {
    const root = this.deps.rootOf(projectId);
    if (root === undefined) return err('unknown-project', 'project is not open');
    await this.deps.consent.set(root, allowed);
    this.log('info', 'ai-consent', { allowed });
    if (!allowed) {
      // Revoking stops every running request of that project (an agent turn would otherwise keep reading files).
      for (const run of this.running.values()) {
        if (run.projectId !== null && this.deps.rootOf(run.projectId) === root) this.abort(run);
      }
    }
    return ok(null);
  }

  // --- requests ---

  /**
   * Checks the request and starts it. The id is returned at once; events (text…, then done or error) go to `sink`.
   * `owner` is the requesting window (webContents id): only it may cancel the request or resolve its proposals.
   */
  async request(request: AiRequest, owner: number, sink: AiSink): Promise<Result<{ requestId: string }, AiErrorCode>> {
    const config = await this.deps.config.get();
    if (!config.enabled) return err('disabled', 'AI is switched off');
    if (request.kind === 'inline' && !config.inlineCompletions) return err('disabled', 'inline completions are off');
    const providerId = config.provider;
    const provider = providerId ? await this.provider(providerId) : null;
    if (!providerId || !provider) return err('no-key', 'no key stored');
    // S39.2: the optional daily budget stops new requests only; running ones finish.
    if (this.deps.usage && (await this.deps.usage.budgetReached())) {
      this.log('info', 'ai-budget-refused', { purpose: request.kind });
      return err('budget-reached', 'daily token budget reached');
    }
    if (request.projectId !== null) {
      const root = this.deps.rootOf(request.projectId);
      if (root === undefined) return err('unknown-project', 'project is not open');
      // A chat follow-up carries code too: earlier turns often quote the project's files (S36.1).
      const carriesCode = request.kind !== 'chat' || request.context.length > 0 || request.history.length > 0;
      if (carriesCode && !(await this.deps.consent.isAllowed(root))) {
        return err('no-consent', 'this project is not allowed to send code yet');
      }
    }
    if (request.kind === 'agent' && !this.deps.agentRunner) return err('provider-error', 'agent not available');

    // A new inline completion replaces the window's previous one (typing moved on).
    if (request.kind === 'inline') {
      for (const run of this.running.values()) if (run.owner === owner && run.kind === 'inline') this.abort(run);
    }

    const requestId = randomUUID();
    const run: Running = {
      owner,
      kind: request.kind,
      projectId: request.projectId,
      provider: providerId,
      controller: new AbortController(),
      agent: null,
      cancelled: false,
      timedOut: false,
    };
    this.running.set(requestId, run);
    void this.execute(requestId, run, request, providerId, provider, sink);
    return ok({ requestId });
  }

  /** Stop: only the window that started the request may cancel it; unknown ids are ignored. */
  cancel(requestId: string, owner: number): void {
    const run = this.running.get(requestId);
    if (run && run.owner === owner) this.abort(run);
  }

  /** The window closed or reloaded: everything it started stops. */
  cancelAllFor(owner: number): void {
    for (const run of this.running.values()) if (run.owner === owner) this.abort(run);
  }

  resolveProposal(decision: AiProposalDecision, owner: number): Result<null, 'unknown-request'> {
    const run = this.running.get(decision.requestId);
    if (!run || run.owner !== owner || run.kind !== 'agent') return err('unknown-request', 'no such running request');
    if (!run.agent?.resolveProposal(decision)) return err('unknown-request', 'not the proposal the agent waits for');
    return ok(null);
  }

  /** For tests and diagnostics: ids of running requests. */
  get active(): readonly string[] {
    return [...this.running.keys()];
  }

  private abort(run: Running): void {
    if (run.cancelled) return;
    run.cancelled = true;
    run.controller.abort();
  }

  private async provider(id: AiProviderId): Promise<AiProvider | null> {
    const key = await this.deps.keys.get(id);
    return key ? this.deps.providers(id, key) : null;
  }

  /** The model for a purpose: the user's choice, else the provider default (OpenAI: picked from its list once). */
  private async modelFor(providerId: AiProviderId, provider: AiProvider, purpose: AiPurpose): Promise<string> {
    const stored = await this.deps.config.modelsOf(providerId);
    if (stored[purpose]) return stored[purpose];
    if (providerId === 'anthropic') return ANTHROPIC_DEFAULT_MODELS[purpose];
    const defaults = pickOpenAiDefaults(await provider.listModels());
    if (!defaults) throw new ProviderError('model-not-found', 'no chat model available for this key');
    return (await this.deps.config.fillModels(providerId, defaults))[purpose];
  }

  private async execute(
    requestId: string,
    run: Running,
    request: AiRequest,
    providerId: AiProviderId,
    provider: AiProvider,
    sink: AiSink,
  ): Promise<void> {
    const started = this.now();
    const budget = this.deps.budgets?.[request.kind] ?? AI_BUDGETS[request.kind];
    const timer = setTimeout(
      () => {
        run.timedOut = true;
        run.controller.abort();
      },
      request.kind === 'agent' ? AGENT_BACKSTOP_MS : budget.timeoutMs,
    );
    let model = '';
    let usage: ProviderUsage | undefined;
    let code: AiErrorCode | 'ok' = 'ok';
    const send = (event: AiEvent) => {
      try {
        sink(event);
      } catch {
        // The window is gone; the request is cancelled through cancelAllFor.
      }
    };
    try {
      model = await this.modelFor(providerId, provider, request.kind);
      if (request.kind === 'agent') {
        const runner = this.deps.agentRunner;
        if (!runner) throw new ProviderError('provider-error', 'agent not available');
        const basePort = this.deps.agentModel?.(providerId, provider, model) ?? toModelPort(provider, model);
        // S39.2: every model call of the turn counts as it ends (also when the turn stops or fails later).
        const port = countingPort(basePort, (callUsage) => this.recordUsage(providerId, callUsage));
        const agentRun = runner(
          {
            requestId,
            request,
            model: port,
            // The loop enforces the turn's working time (excluding waits for the user) and output per step.
            budgets: { maxWallTimeMs: budget.timeoutMs, maxOutputTokensPerStep: budget.maxOutputTokens },
          },
          (event) => {
            // The runner emits exactly one terminal event itself; the service only records it for the log.
            if (event.type === 'done' && event.usage) usage = event.usage;
            if (event.type === 'error') code = event.code;
            send(event);
          },
          run.controller.signal,
        );
        run.agent = agentRun;
        await agentRun.finished;
        return;
      } else {
        await this.runModel(
          request,
          provider,
          model,
          budget,
          run,
          (text) => send({ requestId, type: 'text', text }),
          // Known as soon as the provider reports it, so a refusal's tokens count too (S39.2).
          (reported) => (usage = reported),
        );
      }
      send({
        requestId,
        type: 'done',
        ...(usage ? { usage: { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens } } : {}),
      });
    } catch (e) {
      const mapped = run.timedOut
        ? ({ code: 'provider-error', message: 'timed out' } as const)
        : run.cancelled
          ? ({ code: 'cancelled', message: 'cancelled' } as const)
          : requestErrorOf(e);
      code = mapped.code;
      send({ requestId, type: 'error', code: mapped.code, message: mapped.message });
    } finally {
      clearTimeout(timer);
      this.running.delete(requestId);
      if (request.kind !== 'agent' && usage) this.recordUsage(providerId, usage);
      this.log(code === 'ok' || code === 'cancelled' ? 'info' : 'warn', 'ai-request', {
        id: requestId,
        purpose: request.kind,
        provider: providerId,
        model,
        inputTokens: usage?.inputTokens ?? 0,
        outputTokens: usage?.outputTokens ?? 0,
        ms: this.now() - started,
        result: code,
        ...(run.timedOut ? { timedOut: true } : {}),
      });
    }
  }

  /** Chat, inline and edit: one model turn without tools. */
  private async runModel(
    request: Exclude<AiRequest, { kind: 'agent' }>,
    provider: AiProvider,
    model: string,
    budget: AiBudget,
    run: Running,
    onText: (text: string) => void,
    onUsage: (usage: ProviderUsage) => void,
  ): Promise<void> {
    const { system, messages } = await this.prompt(request);
    // Inline and edit answers are code to insert: buffered, cleaned of a stray Markdown fence, sent as one piece.
    const buffered = request.kind !== 'chat';
    let text = '';
    for await (const event of provider.stream({
      model,
      purpose: request.kind,
      system,
      messages,
      maxOutputTokens: budget.maxOutputTokens,
      effort: budget.effort,
      signal: run.controller.signal,
    })) {
      if (event.type === 'text') {
        text += event.text;
        if (!buffered) onText(event.text);
      } else if (event.type === 'stop') {
        if (event.usage) onUsage(event.usage);
        if (event.reason === 'refusal') throw new RefusedError();
      }
    }
    if (buffered) {
      const cleaned = stripCodeFence(text);
      if (cleaned) onText(cleaned);
    }
  }

  private async prompt(
    request: Exclude<AiRequest, { kind: 'agent' }>,
  ): Promise<{ system: string; messages: ProviderMessage[] }> {
    switch (request.kind) {
      case 'chat': {
        const blocks: string[] = [];
        let total = request.prompt.length;
        for (const item of request.context) {
          let text = item.text;
          if (text === undefined && item.relPath && request.projectId) {
            text = (await this.deps.readFile(request.projectId, item.relPath)) ?? undefined;
          }
          if (text === undefined) continue;
          total += text.length;
          if (total > MAX_CONTEXT_CHARS) throw new ProviderError('context-too-large', 'context is too large');
          blocks.push(contextBlock(item, text));
        }
        for (const m of request.history) total += m.text.length;
        if (total > MAX_CONTEXT_CHARS * 2) throw new ProviderError('context-too-large', 'conversation is too long');
        const mode: ChatMode = request.mode ?? 'chat';
        return {
          system: chatSystemPrompt(mode, request.locale),
          messages: [
            ...historyMessages(request.history),
            { role: 'user', text: chatUserMessage(request.prompt, blocks) },
          ],
        };
      }
      case 'inline':
        return {
          system: inlineSystemPrompt(),
          messages: [
            {
              role: 'user',
              text: inlineUserMessage(request.relPath, request.languageId, request.prefix, request.suffix),
            },
          ],
        };
      case 'edit': {
        if (request.selection.length + request.before.length + request.after.length > MAX_CONTEXT_CHARS) {
          throw new ProviderError('context-too-large', 'selection is too large');
        }
        return {
          system: editSystemPrompt(request.locale),
          messages: [{ role: 'user', text: editUserMessage(request) }],
        };
      }
    }
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  /** S39.2: adds a call's tokens to today's total. Never fails a request. */
  private recordUsage(providerId: AiProviderId, usage: ProviderUsage): void {
    const store = this.deps.usage;
    if (!store) return;
    void store
      .record(providerId, { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens })
      .catch(() => this.log('warn', 'ai-usage-record-failed', { provider: providerId }));
  }

  private log(level: 'info' | 'warn' | 'error', event: string, fields: Record<string, string | number | boolean>) {
    this.deps.log?.(level, event, fields);
  }
}

class RefusedError extends Error {
  constructor() {
    super('the model declined this request');
    this.name = 'RefusedError';
  }
}

/**
 * S39.2: a ModelPort that reports each call's tokens (the last `usage` event of the call) when that call ends —
 * finished, failed or stopped — so an agent turn's spending counts step by step, even if the turn never reaches 'done'.
 */
export function countingPort(port: ModelPort, onCall: (usage: ProviderUsage) => void): ModelPort {
  return {
    provider: port.provider,
    streamTurn: (request) => ({
      async *[Symbol.asyncIterator]() {
        let last: ProviderUsage | null = null;
        try {
          for await (const event of port.streamTurn(request)) {
            if (event.type === 'usage') last = { inputTokens: event.inputTokens, outputTokens: event.outputTokens };
            yield event;
          }
        } finally {
          if (last) onCall(last);
        }
      },
    }),
  };
}

function providerMessage(e: unknown): string {
  return e instanceof ProviderError ? e.message : e instanceof Error ? e.name : 'unknown error';
}

function testErrorOf(e: unknown): AiTestError {
  return (e instanceof ProviderError && TEST_ERRORS[e.code]) || 'provider-error';
}

export function requestErrorOf(e: unknown): { code: AiErrorCode; message: string } {
  if (e instanceof RefusedError) return { code: 'refused', message: e.message };
  if (e instanceof ProviderError) {
    if (e.code === 'model-not-found') return { code: 'provider-error', message: `model not found: ${e.message}` };
    return { code: REQUEST_ERRORS[e.code] ?? 'provider-error', message: e.message };
  }
  return { code: 'provider-error', message: e instanceof Error ? e.name : 'unknown error' };
}
