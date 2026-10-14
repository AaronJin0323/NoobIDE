import { EDITOR_FONT_SIZE } from '../../shared/settings';

/**
 * Code font zoom (S09.3, PLAN §3: start at about 16px, support zoom). The size is persisted in the app settings
 * (S13.1 `editorFontSize`, S24.4); the limits are the settings schema's, so a stored size is always reachable.
 */
export const DEFAULT_FONT_SIZE: number = EDITOR_FONT_SIZE.default;
export const MIN_FONT_SIZE: number = EDITOR_FONT_SIZE.min;
export const MAX_FONT_SIZE: number = EDITOR_FONT_SIZE.max;

/** `step` 1 zooms in, -1 zooms out, 0 resets to the default; the size stays within the limits. */
export function zoomFontSize(size: number, step: 1 | -1 | 0): number {
  if (step === 0) return DEFAULT_FONT_SIZE;
  return Math.min(MAX_FONT_SIZE, Math.max(MIN_FONT_SIZE, size + step));
}
