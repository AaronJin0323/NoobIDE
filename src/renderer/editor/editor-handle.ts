/**
 * A small, Monaco-free handle on the workbench's code editor, so workbench code (format button, problems panel, problem
 * card) can act on the editor without importing Monaco (which stays in its own lazily loaded chunk).
 *
 * CodeEditor registers the live editor; reveal requests for a file that is not on screen yet are kept until the
 * editor shows that file (Go to code opens the file first, S17.2).
 */
export interface RevealTarget {
  /** The workbench's model URI string (OpenTab.uri). */
  readonly uri: string;
  /** 1-based. */
  readonly line: number;
  /** 1-based; defaults to the first column. */
  readonly column?: number;
  /** Move keyboard focus into the editor (Go to code: yes; passive updates: never). */
  readonly focus: boolean;
}

export interface EditorAccess {
  /** URI of the file on screen, or null. */
  shownUri(): string | null;
  /** Formats the document on screen with the language's formatter (S18.3). Resolves when done. */
  formatDocument(): Promise<void>;
  /** Moves the cursor to the target (which must be the shown file) and scrolls it into view. */
  reveal(target: RevealTarget): void;
  /** S33.2: the non-empty selection in the file on screen (its first selection), or null. */
  selection?(): EditorSelection | null;
  /**
   * S35: opens an inline edit zone in the file on screen — over `lines` (whole lines, 1-based inclusive), else over
   * the selected lines, else over the whole file. Null when no file is shown. One zone at a time: opening another
   * closes the previous one.
   */
  openEditZone?(lines?: { readonly startLine: number; readonly endLine: number }): EditZone | null;
  /** S51.1: opens the editor's find (or find-and-replace) widget on the file on screen and focuses its field. */
  openFind?(mode: 'find' | 'replace'): void;
}

/**
 * S35: an inline edit zone in the code editor (Monaco-free view of src/renderer/ai/edit-zone-monaco.ts): space
 * above the edited lines with a DOM container for the instruction box and the proposed diff, and the edited range
 * tracked by a decoration as the user keeps typing elsewhere.
 */
export interface EditZone {
  /** The workbench's model URI string of the file. */
  readonly uri: string;
  readonly languageId: string;
  /** The edited lines when the zone opened (1-based, inclusive). */
  readonly startLine: number;
  readonly endLine: number;
  /** True when nothing was selected: the whole file is the range (including its final line break). */
  readonly wholeFile: boolean;
  /** Text of the range when the zone opened, and of the whole file (for context). */
  readonly original: string;
  readonly fullText: string;
  readonly eol: '\n' | '\r\n';
  /** Where the zone's content is rendered (its own React root: keys typed there never reach the editor). */
  readonly container: HTMLElement;
  /** Current text of the tracked range; null when the file's model is gone or the zone is closed. */
  currentText(): string | null;
  /** Current text of the whole file (null when its model is gone or the zone is closed). */
  modelText(): string | null;
  /** Highlights the tracked range as "to be replaced" while a proposal is reviewed. */
  markProposal(on: boolean): void;
  /**
   * Replaces the tracked range with `text` as ONE undo step, only while it still reads `expected` (line endings
   * aside). `version` identifies the model state right after the edit.
   */
  apply(
    text: string,
    expected: string,
  ):
    | { readonly ok: true; readonly text: string; readonly version: number }
    | { readonly ok: false; readonly reason: 'changed' | 'no-model' };
  /** Puts keyboard focus back into the editor. */
  focusEditor(): void;
  /** Called once when the zone closes for any reason (dispose, the editor showed another file, editor gone). */
  onClose(listener: () => void): void;
  dispose(): void;
}

/** S33.2: a selection in the editor, for AI context ("Explain this code"). */
export interface EditorSelection {
  /** The workbench's model URI string of the file. */
  readonly uri: string;
  /** 1-based, inclusive. */
  readonly startLine: number;
  readonly endLine: number;
  readonly text: string;
}

/**
 * S33.2: actions the workbench adds to the code editor's context menu (e.g. "Ask AI to explain this code"). The
 * editor (re)registers them whenever the list changes; `run` gets the selection at the moment of the click.
 */
export interface EditorContextAction {
  readonly id: string;
  /** Already translated. */
  readonly label: string;
  /** Only offered while text is selected. */
  readonly needsSelection: boolean;
  readonly run: (selection: EditorSelection | null) => void;
}

let contextActions: readonly EditorContextAction[] = [];
const contextListeners = new Set<(actions: readonly EditorContextAction[]) => void>();
// S35: several features add actions (S33 explain, S35 inline edit); each owns a group, shown in group order.
const contextGroups = new Map<string, readonly EditorContextAction[]>();

function publishContextActions(): void {
  contextActions = [...contextGroups.values()].flat();
  for (const listener of [...contextListeners]) listener(contextActions);
}

export function setEditorContextActions(actions: readonly EditorContextAction[]): void {
  setEditorContextActionGroup('default', actions);
}

/** S35: sets the actions of one group, leaving the other groups' actions in place. */
export function setEditorContextActionGroup(group: string, actions: readonly EditorContextAction[]): void {
  if (actions.length === 0) contextGroups.delete(group);
  else contextGroups.set(group, actions);
  publishContextActions();
}

/** For the editor: called now with the current actions and again on every change. Returns the unsubscribe function. */
export function subscribeEditorContextActions(listener: (actions: readonly EditorContextAction[]) => void): () => void {
  contextListeners.add(listener);
  listener(contextActions);
  return () => contextListeners.delete(listener);
}

let active: EditorAccess | null = null;
let pendingReveal: RevealTarget | null = null;

export function registerEditor(access: EditorAccess | null): void {
  active = access;
}

export function activeEditor(): EditorAccess | null {
  return active;
}

/** Reveals now when the file is on screen, otherwise as soon as the editor shows it. */
export function requestReveal(target: RevealTarget): void {
  if (active && active.shownUri() === target.uri) {
    pendingReveal = null;
    active.reveal(target);
  } else {
    pendingReveal = target;
  }
}

/** Called by CodeEditor after it switched to `uri`: applies a reveal that was waiting for this file. */
export function takePendingReveal(uri: string): RevealTarget | null {
  if (pendingReveal?.uri !== uri) return null;
  const target = pendingReveal;
  pendingReveal = null;
  return target;
}

/** Forgets a waiting reveal (e.g. the file could not be opened). */
export function cancelPendingReveal(): void {
  pendingReveal = null;
}

/**
 * S42.3 (decision 0031): what the editor's inline `/ai` prompt support needs from the workbench — whether AI is shown,
 * the translated texts, and how to run a prompt line. Set by useInlineEdit; null when there is no workbench.
 */
export interface AiPromptHooks {
  /** AI surfaces are shown (a key is stored and AI is on). Off: no hints, markers or Enter handling at all. */
  readonly enabled: boolean;
  /** Already translated, `{shortcut}` filled. */
  readonly texts: {
    readonly hintRun: string;
    readonly hintShortcut: string;
    readonly hintBare: string;
    readonly marker: string;
    readonly menu: string;
  };
  /**
   * Runs the prompt on `line` (1-based) of the file on screen (the workbench's model URI). False when it could not:
   * the key that asked then does what it usually does (Enter inserts a line break).
   */
  run(uri: string, line: number): boolean;
  /**
   * Workbench model URIs of the open tabs that cannot be edited (read-only, another encoding). Their files get no
   * pending-prompt warning: nothing could run the prompt there.
   */
  readOnlyUris(): readonly string[];
}

let aiPromptHooks: AiPromptHooks | null = null;
const aiPromptListeners = new Set<(hooks: AiPromptHooks | null) => void>();

export function setAiPromptHooks(hooks: AiPromptHooks | null): void {
  aiPromptHooks = hooks;
  for (const listener of [...aiPromptListeners]) listener(hooks);
}

export function getAiPromptHooks(): AiPromptHooks | null {
  return aiPromptHooks;
}

/** Called now with the current hooks and again on every change. Returns the unsubscribe function. */
export function subscribeAiPromptHooks(listener: (hooks: AiPromptHooks | null) => void): () => void {
  aiPromptListeners.add(listener);
  listener(aiPromptHooks);
  return () => aiPromptListeners.delete(listener);
}
