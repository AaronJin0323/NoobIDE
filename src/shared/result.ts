/**
 * Explicit success/failure values for service APIs (file, preview, recovery).
 * Failures carry a machine-readable code plus the original error so the UI can explain
 * the cause without losing evidence (PLAN §7, §9).
 */
export type Ok<T> = { readonly ok: true; readonly value: T };
export type Err<C extends string = string> = {
  readonly ok: false;
  readonly code: C;
  readonly message: string;
  readonly cause?: unknown;
};
export type Result<T, C extends string = string> = Ok<T> | Err<C>;

export const ok = <T>(value: T): Ok<T> => ({ ok: true, value });

export function err<C extends string>(code: C, message: string, cause?: unknown): Err<C> {
  return cause === undefined ? { ok: false, code, message } : { ok: false, code, message, cause };
}

/** Runs an async operation and converts a thrown error into an Err with the given code. */
export async function attempt<T, C extends string>(code: C, op: () => Promise<T>): Promise<Result<T, C>> {
  try {
    return ok(await op());
  } catch (e) {
    return err(code, e instanceof Error ? e.message : String(e), e);
  }
}
