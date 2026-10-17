/**
 * Opt-in format on save (S53.4). Pure orchestration, so the order and the failure path are integration-tested with a
 * real DocumentSaver: an explicit save formats the file first and then saves what the editor holds, so the saved bytes
 * are the formatted text. Formatting is an ordinary editor edit (one undo step); the save adds none. If formatting
 * fails or takes too long, the text is saved as it is, and the reason is reported, never swallowed.
 *
 * Only explicit saves (Ctrl/Cmd+S, the Save button or menu) format: autosave never rewrites what the user is typing.
 */
export type FormatFailure = 'failed' | 'timeout';

export type FormatOutcome =
  | { readonly ok: true }
  /** The file has no formatter (not HTML, CSS or JavaScript) or is read-only: saved as it is, nothing to report. */
  | { readonly ok: false; readonly reason: 'unsupported' }
  | { readonly ok: false; readonly reason: FormatFailure };

export const FORMAT_ON_SAVE_TIMEOUT_MS = 3_000;

export interface FormatOnSaveDeps {
  readonly enabled: boolean;
  /** Formats the document in the editor (the edit reaches the saver through the editor's change event). */
  format(): Promise<FormatOutcome>;
  /** The saver's save(): true once the newest text is confirmed on disk. */
  save(): Promise<boolean>;
  /** Says why formatting did not happen (the file is saved anyway). */
  onFormatFailed(reason: FormatFailure): void;
  readonly timeoutMs?: number;
}

/** Formats (when on), then saves. Resolves with the save's result. */
export async function saveWithFormat(deps: FormatOnSaveDeps): Promise<boolean> {
  if (deps.enabled) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<FormatOutcome>((resolve) => {
      timer = setTimeout(() => resolve({ ok: false, reason: 'timeout' }), deps.timeoutMs ?? FORMAT_ON_SAVE_TIMEOUT_MS);
    });
    let outcome: FormatOutcome;
    try {
      outcome = await Promise.race([deps.format(), timeout]);
    } catch {
      outcome = { ok: false, reason: 'failed' };
    } finally {
      clearTimeout(timer);
    }
    if (!outcome.ok && outcome.reason !== 'unsupported') deps.onFormatFailed(outcome.reason);
  }
  return deps.save();
}
