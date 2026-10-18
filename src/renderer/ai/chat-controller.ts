/**
 * The AI chat panel's controller (S33.1): owns the chat state (chat-model.ts), talks to main through the typed AI
 * bridge (`window.noobide.ai`, contract src/shared/ipc/ai-contract.ts) and reads the workbench (open project, files,
 * selection) through a small host interface. No React and no DOM, so it is unit-tested against a fake AiApi.
 *
 * Rules (decision 0025):
 * - A request carries exactly the chips the user saw in the draft (a file chip's text is the open buffer at send time,
 *   or none so main reads the file from disk). Nothing is added behind the user's back.
 * - A request with an open project waits for that project's consent; the consent question is shown first.
 * - Events of other requests on the shared event channel (inline completions, edits) are ignored.
 */
import type { AiApi, AiChatMessage, AiContextItem, AiEvent, AiRequest } from '../../shared/ipc/ai-contract';
import type { AnnotationContext } from '../../shared/ipc/annotations-contract';
import { planRetry } from './backoff';
import {
  INITIAL_CHAT_STATE,
  activeConversation,
  availabilityOf,
  chatReducer,
  draftOf,
  historyOf,
  projectKeyOf,
  runningTurn,
  type ChatAction,
  type ChatChip,
  type ChatDraft,
  type ChatMode,
  type ChatState,
  type ChatTurn,
  type Conversation,
  type TurnKind,
} from './chat-model';

export interface SelectionContext {
  readonly relPath: string;
  /** 1-based, inclusive. */
  readonly startLine: number;
  readonly endLine: number;
  readonly text: string;
}

/** What the controller reads from the workbench. Called at the moment of use, so values are always current. */
export interface AiChatHost {
  projectId(): string | null;
  locale(): 'zh-CN' | 'en';
  /** Project-relative path of the active tab, or null. */
  activeFile(): string | null;
  /** The open buffer's text (possibly unsaved), or undefined when the file is not open. */
  fileText(relPath: string): string | undefined;
  /** The code editor's non-empty selection in a project file, or null. */
  selection(): SelectionContext | null;
}

export interface ProblemContext {
  readonly relPath?: string | undefined;
  readonly line?: number | undefined;
  /** The card's title in the UI language. */
  readonly title: string;
  /** The original message exactly as reported (and its code). */
  readonly originalMessage: string;
  readonly code?: string | undefined;
}

/** Builds the request of a turn. S34 can replace it (agent turns); the default covers 'chat' and 'agent' kinds. */
export type RequestBuilder = (input: {
  readonly kind: TurnKind;
  readonly projectId: string | null;
  readonly prompt: string;
  readonly mode: ChatMode;
  readonly history: readonly AiChatMessage[];
  readonly context: readonly AiContextItem[];
  readonly locale: 'zh-CN' | 'en';
}) => AiRequest | null;

export const defaultRequestBuilder: RequestBuilder = (input) => {
  if (input.kind === 'agent') {
    if (!input.projectId) return null;
    return {
      kind: 'agent',
      projectId: input.projectId,
      history: input.history,
      prompt: input.prompt,
      context: input.context,
      locale: input.locale,
    };
  }
  return {
    kind: 'chat',
    projectId: input.projectId,
    history: input.history,
    prompt: input.prompt,
    context: input.context,
    mode: input.mode,
    locale: input.locale,
  };
};

const MAX_EARLY_EVENTS = 2000;

/** S48.7: time and chance for the backoff (tests pass a fake clock). */
export interface ChatClock {
  now(): number;
  random(): number;
  setTimeout(run: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const REAL_CLOCK: ChatClock = {
  now: () => Date.now(),
  random: () => Math.random(),
  setTimeout: (run, ms) => setTimeout(run, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export class AiChatController {
  private state: ChatState = INITIAL_CHAT_STATE;
  private readonly listeners = new Set<() => void>();
  private seq = 0;
  private unsubscribe: (() => void) | null = null;
  /** Events that arrived before `request()` returned their id (IPC replies and events are not ordered). */
  private early: AiEvent[] = [];
  /** Turns whose Stop was pressed before their request id arrived. */
  private readonly stopOnAssign = new Set<string>();
  private statusSeq = 0;
  /** S48.7: automatic retries waiting, per turn. */
  private readonly retryTimers = new Map<string, unknown>();

  constructor(
    private readonly api: AiApi | undefined,
    private host: AiChatHost,
    private buildRequest: RequestBuilder = defaultRequestBuilder,
    private readonly clock: ChatClock = REAL_CLOCK,
  ) {
    if (!api) this.state = { ...this.state, availability: { kind: 'unavailable' } };
  }

  // ── store ──
  getState = (): ChatState => this.state;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  private dispatch(action: ChatAction): void {
    const next = chatReducer(this.state, action);
    if (next === this.state) return;
    this.state = next;
    for (const listener of [...this.listeners]) listener();
  }

  setHost(host: AiChatHost): void {
    this.host = host;
  }
  setRequestBuilder(builder: RequestBuilder | undefined): void {
    this.buildRequest = builder ?? defaultRequestBuilder;
  }

  /** Starts listening to main's events. Returns the stop function; idempotent. */
  start(): () => void {
    if (this.api && !this.unsubscribe) this.unsubscribe = this.api.onEvent((event) => this.onEvent(event));
    return () => this.dispose();
  }
  dispose(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    for (const timer of this.retryTimers.values()) this.clock.clearTimeout(timer);
    this.retryTimers.clear();
  }

  private nextId(prefix: string): string {
    this.seq += 1;
    return `${prefix}${this.seq}`;
  }
  private get key() {
    return projectKeyOf(this.host.projectId());
  }

  /** Reads AI settings and the open project's consent from main. */
  async refreshStatus(): Promise<void> {
    if (!this.api) return;
    const seq = ++this.statusSeq;
    try {
      const result = await this.api.status({ projectId: this.host.projectId() });
      if (seq !== this.statusSeq) return;
      if (result.ok) this.dispatch({ type: 'availability', availability: availabilityOf(result.value) });
    } catch {
      // The bridge failed (window closing): keep what we know.
    }
  }

  // ── panel ──
  open(options: { focus?: boolean } = {}): void {
    const wasOpen = this.state.open;
    this.dispatch({ type: 'setOpen', open: true, focus: options.focus ?? true });
    // Opening the panel suggests the current file as context once, when the draft has none.
    const draft = draftOf(this.state, this.key);
    const file = this.host.activeFile();
    if (!wasOpen && file && draft.chips.length === 0 && draft.prompt === '' && this.host.projectId()) {
      this.addChip({ kind: 'file', relPath: file });
    }
    void this.refreshStatus();
  }
  close(): void {
    this.dispatch({ type: 'setOpen', open: false });
  }
  toggle(): void {
    if (this.state.open) this.close();
    else this.open();
  }

  // ── draft ──
  setPrompt(prompt: string): void {
    this.dispatch({ type: 'setPrompt', projectKey: this.key, prompt });
  }
  setKind(kind: TurnKind): void {
    this.dispatch({ type: 'setKind', projectKey: this.key, kind });
  }
  private chip(item: AiContextItem, preview?: ChatChip['preview']): ChatChip {
    return { id: this.nextId('chip'), item, ...(preview ? { preview } : {}) };
  }
  /**
   * S41.6 "Ask AI" on preview annotations: a fresh agent conversation whose draft holds one Annotation chip per
   * annotation (the text main built, shown as is) and a suggested prompt. Nothing is sent until the user sends.
   */
  askAboutAnnotations(annotations: readonly AnnotationContext[], prompt: string): void {
    const chips: ChatChip[] = annotations.map((a) => ({
      id: this.nextId('chip'),
      item: {
        kind: 'annotation',
        text: a.text,
        label: a.label,
        ...(a.relPath !== undefined && a.startLine !== undefined && a.endLine !== undefined
          ? { relPath: a.relPath, startLine: a.startLine, endLine: a.endLine }
          : {}),
      },
      annotation: { ranges: a.ranges },
    }));
    this.dispatch({ type: 'startExplain', projectKey: this.key, chips, mode: 'chat', prompt, kind: 'agent' });
    void this.refreshStatus();
  }
  /** S41.6: the annotations could not be read (main said so); shown as the panel's notice. */
  annotationsFailed(): void {
    this.dispatch({ type: 'setOpen', open: true });
    this.dispatch({ type: 'notice', notice: 'ai.chat.context.annotationFailed' });
  }
  addChip(item: AiContextItem): void {
    this.dispatch({ type: 'addChip', projectKey: this.key, chip: this.chip(item) });
  }
  removeChip(id: string): void {
    this.dispatch({ type: 'removeChip', projectKey: this.key, id });
  }
  /** "Add current file": false (with a notice) when no file is open. */
  addCurrentFile(): boolean {
    const file = this.host.activeFile();
    if (!file) {
      this.dispatch({ type: 'notice', notice: 'ai.chat.context.noFile' });
      return false;
    }
    this.addChip({ kind: 'file', relPath: file });
    return true;
  }
  /** S48.4: an accepted @file mention in the composer: a file chip (the same chip as "Add current file"). */
  addFile(relPath: string): void {
    if (!this.host.projectId()) return;
    this.addChip({ kind: 'file', relPath });
  }
  /** "Add selected code": false (with a notice) when nothing is selected. */
  addSelection(): boolean {
    const selection = this.host.selection();
    if (!selection) {
      this.dispatch({ type: 'notice', notice: 'ai.chat.context.noSelection' });
      return false;
    }
    this.addChip(selectionItem(selection));
    return true;
  }
  /**
   * S38.2 "Add preview": asks main for a snapshot of the project's running preview and shows it as a chip with
   * exactly the text (and the screenshot) that will be sent. Nothing is sent until the user sends; sending needs the
   * project's consent like code. False (with a notice) when the preview is not running or not answering.
   */
  async addPreview(): Promise<boolean> {
    const projectId = this.host.projectId();
    if (!this.api || !projectId) return false;
    const key = this.key;
    let result: Awaited<ReturnType<AiApi['previewSnapshot']>>;
    try {
      result = await this.api.previewSnapshot({ projectId, locale: this.host.locale() });
    } catch {
      result = { ok: false, code: 'not-available', message: '' };
    }
    if (this.key !== key) return false; // the project changed meanwhile
    if (!result.ok) {
      this.dispatch({
        type: 'notice',
        notice:
          result.code === 'not-available' ? 'ai.chat.context.previewUnavailable' : 'ai.chat.context.previewNotRunning',
      });
      return false;
    }
    const snapshot = result.value;
    this.dispatch({
      type: 'addChip',
      projectKey: key,
      chip: this.chip(
        { kind: 'preview', label: snapshot.path, text: snapshot.text, snapshotId: snapshot.snapshotId },
        { thumbnail: snapshot.screenshot?.dataUrl ?? null, imagesAccepted: snapshot.imagesAccepted },
      ),
    });
    return true;
  }
  newConversation(): void {
    this.dispatch({ type: 'newConversation', projectKey: this.key });
  }
  selectConversation(id: string): void {
    this.dispatch({ type: 'selectConversation', projectKey: this.key, id });
  }
  /** S48.7: a draft kept in app data comes back (draft-sync.ts); it never replaces what was typed meanwhile. */
  restoreDraft(projectId: string | null, conversationId: string | null, draft: ChatDraft): void {
    this.dispatch({ type: 'restoreDraft', projectKey: projectKeyOf(projectId), conversationId, draft });
  }
  /** A short status line under the chips (by message key). */
  showNotice(notice: string): void {
    this.dispatch({ type: 'notice', notice });
  }
  /** S39.1: shows a reopened saved chat (chat-history.ts builds it). */
  restoreConversation(conversation: Conversation): void {
    this.dispatch({ type: 'restoreConversation', conversation });
  }
  /** S39.1: a saved chat was deleted; it leaves the in-memory list too. */
  removeConversation(id: string): void {
    this.dispatch({ type: 'removeConversation', id });
  }

  // ── S33.2 entry points: open the chat with the right context and mode; nothing is sent until the user sends ──
  explainCode(selection: SelectionContext | null, prompt: string): void {
    const file = this.host.activeFile();
    const items: AiContextItem[] = selection
      ? [selectionItem(selection)]
      : file
        ? [{ kind: 'file', relPath: file }]
        : [];
    this.dispatch({
      type: 'startExplain',
      projectKey: this.key,
      chips: items.map((item) => this.chip(item)),
      mode: 'explain-code',
      prompt,
    });
    void this.refreshStatus();
  }
  explainProblem(problem: ProblemContext, prompt: string): void {
    const items: AiContextItem[] = [problemItem(problem)];
    if (problem.relPath) items.push({ kind: 'file', relPath: problem.relPath });
    this.dispatch({
      type: 'startExplain',
      projectKey: this.key,
      chips: items.map((item) => this.chip(item)),
      mode: 'explain-problem',
      prompt,
    });
    void this.refreshStatus();
  }

  // ── consent (the placeholder or S31's component calls these) ──
  /** The user allowed the project: refresh the status and send the waiting question. */
  async consentGiven(): Promise<void> {
    this.dispatch({ type: 'consent', projectKey: null });
    await this.refreshStatus();
    await this.send();
  }
  consentDeclined(): void {
    this.dispatch({ type: 'consent', projectKey: null });
    this.dispatch({ type: 'notice', notice: 'ai.consent.declined' });
  }

  // ── sending ──
  /** Sends the draft. Resolves once the request was started (or refused); the answer streams in afterwards. */
  async send(): Promise<void> {
    if (!this.api) return;
    const key = this.key;
    const projectId = this.host.projectId();
    const draft = draftOf(this.state, key);
    const prompt = draft.prompt.trim();
    if (!prompt) return;
    const conversation = activeConversation(this.state, key);
    if (runningTurn(conversation)) return; // one question at a time per conversation
    await this.refreshStatus();
    const availability = this.state.availability;
    if (availability.kind !== 'ready') return; // the panel explains why (off, no key, no keychain)
    if (projectId && !availability.consent) {
      this.dispatch({ type: 'consent', projectKey: key });
      return;
    }
    // The draft may have changed while the status was read; send what is shown now.
    const current = draftOf(this.state, key);
    if (current.prompt.trim() !== prompt || this.key !== key) return;
    const context = current.chips.map((chip) => this.resolve(chip.item));
    const history = historyOf(conversation);
    const request = this.buildRequest({
      kind: current.kind,
      projectId,
      prompt,
      mode: current.mode,
      history,
      context,
      locale: this.host.locale(),
    });
    if (!request) return;
    const annotationRanges = current.chips.flatMap((chip) => chip.annotation?.ranges ?? []);
    const turn: ChatTurn = {
      id: this.nextId('turn'),
      kind: current.kind,
      mode: current.mode,
      prompt,
      context,
      ...(annotationRanges.length > 0 ? { annotationRanges } : {}),
      requestId: null,
      status: 'sending',
      stopping: false,
      parts: [],
    };
    const conversationId = conversation?.id ?? this.nextId('conv');
    for (const earlier of conversation?.turns ?? []) this.cancelRetryTimer(earlier.id);
    this.dispatch({ type: 'turnStarted', projectKey: key, conversationId, turn });
    await this.run(turn.id, request, key, projectId);
  }

  /**
   * S48.7 Retry: asks a failed question again in place, with exactly what it was sent with. Only the last question of
   * its conversation, while nothing else there is running, and never one that proposed changes (those may have been
   * applied). `automatic` is the backoff's own retry; a Retry by hand cancels a waiting one.
   */
  async retry(turnId: string, automatic = false): Promise<void> {
    this.cancelRetryTimer(turnId);
    if (!this.api) return;
    const conversation = this.state.conversations.find((c) => c.turns.at(-1)?.id === turnId);
    const turn = conversation?.turns.at(-1);
    if (!conversation || !turn || !canRetry(turn)) return;
    const key = conversation.projectKey;
    const projectId = key === '' ? null : key;
    // A project that is no longer open cannot be asked about.
    if (projectId !== null && this.host.projectId() !== projectId) return this.giveUp(turn);
    await this.refreshStatus();
    const availability = this.state.availability;
    if (availability.kind !== 'ready') return this.giveUp(turn);
    if (projectId && !availability.consent) {
      if (this.key === key) this.dispatch({ type: 'consent', projectKey: key });
      return this.giveUp(turn);
    }
    const current = this.state.conversations.find((c) => c.id === conversation.id);
    if (current?.turns.at(-1)?.id !== turnId || current.turns.at(-1)?.status !== 'error') return;
    const request = this.buildRequest({
      kind: turn.kind,
      projectId,
      prompt: turn.prompt,
      mode: turn.mode,
      history: historyOf(current),
      context: turn.context,
      locale: this.host.locale(),
    });
    if (!request) return;
    this.dispatch({ type: 'retryStarted', turnId, automatic });
    await this.run(turnId, request, key, projectId);
  }

  /** The waiting automatic retry is dropped; the manual Retry stays. */
  private giveUp(turn: ChatTurn): void {
    if (turn.retry?.dueAt)
      this.dispatch({ type: 'retryScheduled', turnId: turn.id, retry: { ...turn.retry, dueAt: null } });
  }

  private cancelRetryTimer(turnId: string): void {
    const timer = this.retryTimers.get(turnId);
    if (timer === undefined) return;
    this.clock.clearTimeout(timer);
    this.retryTimers.delete(turnId);
  }

  /** S48.7: after a failure, a 429 or 503 waits and retries by itself (backoff.ts); anything else waits for Retry. */
  private afterFailure(turnId: string): void {
    const turn = this.state.conversations.flatMap((c) => c.turns).find((t) => t.id === turnId);
    if (!turn || turn.status !== 'error' || !turn.error || !canRetry(turn)) return;
    const automatic = turn.retry?.automatic ?? 0;
    const plan = planRetry(turn.error, automatic, this.clock.random());
    if (plan.kind === 'manual') {
      if (plan.cause !== null) {
        this.dispatch({ type: 'retryScheduled', turnId, retry: { automatic, dueAt: null, cause: plan.cause } });
      }
      return;
    }
    this.dispatch({
      type: 'retryScheduled',
      turnId,
      retry: { automatic, dueAt: this.clock.now() + plan.delayMs, cause: plan.cause },
    });
    this.cancelRetryTimer(turnId);
    this.retryTimers.set(
      turnId,
      this.clock.setTimeout(() => {
        this.retryTimers.delete(turnId);
        void this.retry(turnId, true);
      }, plan.delayMs),
    );
  }

  /** Starts the request of a turn already in the conversation ('sending'); the answer streams in afterwards. */
  private async run(turnId: string, request: AiRequest, key: string, projectId: string | null): Promise<void> {
    const turn = { id: turnId };
    if (!this.api) return;
    let result: Awaited<ReturnType<AiApi['request']>>;
    try {
      result = await this.api.request(request);
    } catch {
      result = { ok: false, code: 'provider-error', message: '' };
    }
    if (!result.ok) {
      // A Stop pressed while it was starting is settled: a later Retry of this turn (same id) must not be stopped.
      this.stopOnAssign.delete(turn.id);
      this.dispatch({ type: 'requestFailed', turnId: turn.id, code: result.code, message: result.message });
      if (result.code === 'no-consent' && projectId) this.dispatch({ type: 'consent', projectKey: key });
      if (result.code === 'no-key' || result.code === 'disabled' || result.code === 'no-consent') {
        void this.refreshStatus();
      }
      this.dropEarly();
      this.afterFailure(turn.id);
      return;
    }
    const { requestId } = result.value;
    this.dispatch({ type: 'requestAssigned', turnId: turn.id, requestId });
    const early = this.early.filter((event) => event.requestId === requestId);
    this.early = this.early.filter((event) => event.requestId !== requestId);
    for (const event of early) this.handleEvent(event);
    this.dropEarly();
    if (this.stopOnAssign.delete(turn.id)) void this.stop();
  }

  /** Stop: asks main to cancel the running request of the shown conversation. */
  async stop(): Promise<void> {
    const turn = runningTurn(activeConversation(this.state, this.key));
    if (!turn || !this.api) return;
    this.dispatch({ type: 'stopping', turnId: turn.id });
    if (!turn.requestId) {
      this.stopOnAssign.add(turn.id);
      return;
    }
    try {
      await this.api.cancel({ requestId: turn.requestId });
    } catch {
      // Ended locally below.
    }
    // Main normally ends the stream with a 'cancelled' error; if nothing came, the turn ends here.
    this.dispatch({ type: 'stopped', turnId: turn.id });
  }

  private resolve(item: AiContextItem): AiContextItem {
    if (item.kind !== 'file' || item.text !== undefined || !item.relPath) return item;
    const text = this.host.fileText(item.relPath);
    return text === undefined ? item : { ...item, text };
  }

  private knownRequest(requestId: string): boolean {
    return this.state.conversations.some((c) => c.turns.some((turn) => turn.requestId === requestId));
  }
  private sending(): boolean {
    return this.state.conversations.some((c) => c.turns.some((turn) => turn.status === 'sending'));
  }
  private dropEarly(): void {
    if (!this.sending()) this.early = [];
  }

  private handleEvent(event: AiEvent): void {
    this.dispatch({ type: 'event', event });
    if (event.type !== 'error') return;
    const turn = this.state.conversations.flatMap((c) => c.turns).find((t) => t.requestId === event.requestId);
    if (turn) this.afterFailure(turn.id);
  }

  private onEvent(event: AiEvent): void {
    if (this.knownRequest(event.requestId)) {
      this.handleEvent(event);
    } else if (this.sending() && this.early.length < MAX_EARLY_EVENTS) {
      this.early.push(event);
    }
    // Otherwise: another feature's request (inline completion, edit): not ours.
  }
}

/** S48.7: a failed question can be asked again unless it proposed changes (they may have been applied). */
export function canRetry(turn: ChatTurn): boolean {
  return turn.status === 'error' && !turn.parts.some((part) => part.kind === 'proposal');
}

export function selectionItem(selection: SelectionContext): AiContextItem {
  return {
    kind: 'selection',
    relPath: selection.relPath,
    startLine: selection.startLine,
    endLine: selection.endLine,
    text: selection.text,
  };
}

export function problemItem(problem: ProblemContext): AiContextItem {
  const original =
    problem.code && !problem.originalMessage.includes(problem.code)
      ? `${problem.code}: ${problem.originalMessage}`
      : problem.originalMessage;
  return {
    kind: 'problem',
    ...(problem.relPath ? { relPath: problem.relPath } : {}),
    ...(problem.line ? { startLine: problem.line, endLine: problem.line } : {}),
    label: problem.title,
    text: original,
  };
}
