import { randomUUID } from 'node:crypto';
import {
  type AiConfig,
  type AiErrorCode,
  type AiEvent,
  type AiKeyError,
  type AiModelInfo,
  type AiProposalDecision,
  type AiProviderId,
  type AiPreviewSnapshot,
  type AiPreviewSnapshotError,
  type AiPurpose,
  type AiRequest,
  type AiStatus,
  type AiTestError,
} from '../shared/ipc/ai-contract';
import { err, ok, type Result } from '../shared/result';
import type { AiConfigStore, AiConsentStore } from './config-store';
import type { AiUsageStore } from './usage-store';
import type { KeyStore } from './keys';
import type { AgentImage, ModelPort } from './agent/model-port';
import { capturePreview, previewContextText, type PreviewSource } from './preview-context';
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
  modelAcceptsImages,
  pickOpenAiDefaults,
  ProviderError,
  type AiProvider,
  type ProviderEffort,
  type ProviderErrorCode,
  type ProviderFactory,
  type ProviderImage,
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
  /**
   * S38.2: the PreviewManager (page snapshots, recent records) and its owner check: only the window that started a
   * project's preview gets its snapshot.
   */
  readonly preview?: PreviewSource & {
    isOwner(requester: { readonly windowId: number; readonly projectId?: string }): boolean;
  };
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

/**
 * S38.2: screenshots of Preview chips main keeps, so a request sends the image the user saw (the renderer never sends
 * image bytes). Per window at most PREVIEW_SNAPSHOTS_PER_WINDOW, each for PREVIEW_SNAPSHOT_TTL_MS; at most
 * MAX_REQUEST_IMAGES images per request.
 */
export const PREVIEW_SNAPSHOTS_PER_WINDOW = 4;
export const PREVIEW_SNAPSHOT_TTL_MS = 30 * 60_000;
export const MAX_REQUEST_IMAGES = 2;

interface CachedSnapshot {
  readonly owner: number;
  readonly projectId: string;
  readonly png: string | null;
  readonly at: number;
}

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
  private readonly snapshots = new Map<string, CachedSnapshot>();
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

  // --- S38.2: preview snapshots for the Preview chip ---

  /**
   * Takes a snapshot of the project's running preview for the window that owns it: the text shown in the chip (and
   * sent with the question) and the screenshot. Nothing leaves the machine here, so no consent is needed yet; the
   * request that sends it needs the project's consent like code. Logs sizes and the result only, never page text.
   */
  async previewSnapshot(
    projectId: string,
    locale: 'zh-CN' | 'en',
    owner: number,
  ): Promise<Result<AiPreviewSnapshot, AiPreviewSnapshotError>> {
    const started = this.now();
    const finish = <T extends Result<AiPreviewSnapshot, AiPreviewSnapshotError>>(result: T, extra = {}): T => {
      this.log('info', 'ai-preview-snapshot', {
        result: result.ok ? 'ok' : result.code,
        ms: this.now() - started,
        ...extra,
      });
      return result;
    };
    const config = await this.deps.config.get();
    if (!config.enabled) return finish(err('disabled', 'AI is switched off'));
    if (this.deps.rootOf(projectId) === undefined) return finish(err('unknown-project', 'project is not open'));
    const preview = this.deps.preview;
    if (!preview || !preview.isOwner({ windowId: owner, projectId })) {
      return finish(err('not-running', 'this window has no preview of the project'));
    }
    const capture = await capturePreview(preview, projectId, { screenshot: true });
    if (!capture.ok) return finish(capture);
    const text = previewContextText(capture.value, locale);
    const snapshotId = randomUUID();
    this.pruneSnapshots(owner);
    this.snapshots.set(snapshotId, { owner, projectId, png: capture.value.png, at: this.now() });
    const imagesAccepted = config.provider
      ? {
          chat: modelAcceptsImages(config.provider, await this.storedModel(config.provider, 'chat')),
          agent: modelAcceptsImages(config.provider, await this.storedModel(config.provider, 'agent')),
        }
      : { chat: false, agent: false };
    const { png, width, height } = capture.value;
    return finish(
      ok({
        snapshotId,
        path: capture.value.path,
        text,
        screenshot: png ? { dataUrl: `data:image/png;base64,${png}`, width, height } : null,
        imagesAccepted,
      }),
      { chars: text.length, screenshot: png !== null },
    );
  }

  /** Drops expired snapshots (of every window) and keeps room for one more of `owner`. */
  private pruneSnapshots(owner: number | null): void {
    const now = this.now();
    const mine: string[] = [];
    for (const [id, s] of this.snapshots) {
      if (now - s.at > PREVIEW_SNAPSHOT_TTL_MS) this.snapshots.delete(id);
      else if (s.owner === owner) mine.push(id);
    }
    while (owner !== null && mine.length >= PREVIEW_SNAPSHOTS_PER_WINDOW) this.snapshots.delete(mine.shift() as string);
  }

  /** A Preview item names a snapshot whose screenshot main no longer keeps for this window and project. */
  private missingSnapshot(request: AiRequest, owner: number): boolean {
    if ((request.kind !== 'chat' && request.kind !== 'agent') || request.projectId === null) return false;
    this.pruneSnapshots(null);
    return request.context.some((item) => {
      if (item.kind !== 'preview' || !item.snapshotId) return false;
      const cached = this.snapshots.get(item.snapshotId);
      return !cached || cached.owner !== owner || cached.projectId !== request.projectId;
    });
  }

  /** The screenshots of a request's Preview items, from this window's snapshots of this project only. */
  private contextImages(request: AiRequest, owner: number): ProviderImage[] {
    if ((request.kind !== 'chat' && request.kind !== 'agent') || request.projectId === null) return [];
    const images: ProviderImage[] = [];
    for (const item of request.context) {
      if (item.kind !== 'preview' || !item.snapshotId || images.length >= MAX_REQUEST_IMAGES) continue;
      const cached = this.snapshots.get(item.snapshotId);
      if (!cached || cached.owner !== owner || cached.projectId !== request.projectId || !cached.png) continue;
      if (this.now() - cached.at > PREVIEW_SNAPSHOT_TTL_MS) continue;
      images.push({ mediaType: 'image/png', data: cached.png });
    }
    return images;
  }

  /** The configured model of a purpose without asking the provider ('' when none is stored: the default). */
  private async storedModel(providerId: AiProviderId, purpose: AiPurpose): Promise<string> {
    const stored = (await this.deps.config.modelsOf(providerId))[purpose];
    return stored || (providerId === 'anthropic' ? ANTHROPIC_DEFAULT_MODELS[purpose] : '');
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
    // S38.2: a Preview chip promised its screenshot; if main no longer keeps it, say so instead of sending less.
    if (this.missingSnapshot(request, owner)) return err('preview-expired', 'the preview screenshot expired');

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
    for (const [id, s] of this.snapshots) if (s.owner === owner) this.snapshots.delete(id);
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
        const contextImages: AgentImage[] = this.contextImages(request, run.owner);
        const agentRun = runner(
          {
            requestId,
            request,
            model: port,
            owner: run.owner,
            ...(contextImages.length > 0 ? { contextImages } : {}),
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
      send({ requestId, type: 'error', ...mapped });
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
    // S38.2: the Preview chips' screenshots, for a model that reads images (the chip said whether it does).
    const images = modelAcceptsImages(provider.id, model) ? this.contextImages(request, run.owner) : [];
    const last = messages.at(-1);
    if (images.length > 0 && last?.role === 'user') messages[messages.length - 1] = { ...last, images };
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
    // A stream may end quietly when it is aborted (Stop, time budget): a cut-off answer is never sent as complete.
    if (run.controller.signal.aborted) throw new ProviderError('cancelled', 'cancelled');
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
          system: editSystemPrompt(request.locale, request.mode),
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

export function requestErrorOf(e: unknown): {
  code: AiErrorCode;
  message: string;
  status?: number;
  retryAfterSeconds?: number;
} {
  if (e instanceof RefusedError) return { code: 'refused', message: e.message };
  if (e instanceof ProviderError) {
    if (e.code === 'model-not-found') return { code: 'provider-error', message: `model not found: ${e.message}` };
    return {
      code: REQUEST_ERRORS[e.code] ?? 'provider-error',
      message: e.message,
      ...httpDetails(e.status, e.retryAfterSeconds),
    };
  }
  return { code: 'provider-error', message: e instanceof Error ? e.name : 'unknown error' };
}

/** S48.7: the HTTP status and Retry-After of a provider failure, for the renderer's backoff (never a body). */
export function httpDetails(
  status: number | undefined,
  retryAfterSeconds: number | undefined,
): { status?: number; retryAfterSeconds?: number } {
  return {
    ...(status !== undefined && Number.isInteger(status) ? { status } : {}),
    ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}),
  };
}
