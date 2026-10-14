/** Code font zoom (S09.3, PLAN §3: start at about 16px, support zoom). Persisting the choice arrives with S24.4. */
export const DEFAULT_FONT_SIZE = 16;
export const MIN_FONT_SIZE = 10;
export const MAX_FONT_SIZE = 32;

/** `step` 1 zooms in, -1 zooms out, 0 resets to the default; the size stays within the limits. */
export function zoomFontSize(size: number, step: 1 | -1 | 0): number {
  if (step === 0) return DEFAULT_FONT_SIZE;
  return Math.min(MAX_FONT_SIZE, Math.max(MIN_FONT_SIZE, size + step));
}
