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

export function setEditorContextActions(actions: readonly EditorContextAction[]): void {
  contextActions = actions;
  for (const listener of [...contextListeners]) listener(actions);
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
