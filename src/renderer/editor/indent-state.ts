/**
 * The indentation of the file on screen, for the status bar (S43.2, decision 0032). Monaco-free: the editor module
 * (indent-monaco.ts) publishes the resolved style and registers the commands; the workbench reads both through this
 * module without importing Monaco, like editor-handle.ts.
 *
 * Overrides chosen in the status bar are kept here per file URI until the app closes.
 */
import type { IndentStyle, ResolvedIndent } from './indent-detect';

export interface ShownIndent {
  readonly uri: string;
  readonly indent: ResolvedIndent;
}

export interface IndentCommands {
  /** Re-resolves the file's indentation now (after an override changed or "Detect again"). */
  reapply(uri: string): void;
  /** Rewrites the file's existing indentation into its current style, as one undoable edit. */
  convert(uri: string): void;
}

let shown: ShownIndent | null = null;
let commands: IndentCommands | null = null;
const overrides = new Map<string, IndentStyle>();
const listeners = new Set<() => void>();

export function publishIndent(next: ShownIndent | null): void {
  const same =
    next === shown ||
    (next !== null &&
      shown !== null &&
      next.uri === shown.uri &&
      next.indent.insertSpaces === shown.indent.insertSpaces &&
      next.indent.tabSize === shown.indent.tabSize &&
      next.indent.source === shown.indent.source &&
      next.indent.mixed === shown.indent.mixed);
  if (same) return;
  shown = next;
  for (const listener of listeners) listener();
}

export function shownIndent(): ShownIndent | null {
  return shown;
}

export function subscribeIndent(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function registerIndentCommands(next: IndentCommands | null): void {
  commands = next;
}

export function indentOverride(uri: string): IndentStyle | null {
  return overrides.get(uri) ?? null;
}

/** Sets (or with null clears: "Detect again") the user's choice for a file and applies it. */
export function setIndentOverride(uri: string, style: IndentStyle | null): void {
  if (style) overrides.set(uri, style);
  else overrides.delete(uri);
  commands?.reapply(uri);
}

export function convertIndentation(uri: string): void {
  commands?.convert(uri);
}

/** Tests only. */
export function resetIndentState(): void {
  shown = null;
  commands = null;
  overrides.clear();
  listeners.clear();
}
