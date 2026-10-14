/**
 * Session state shared by main and the workbench (S13.4): which files were open in a project, which one was visible,
 * and the sizes of the workbench layout. Pure TypeScript with the validators main runs on every payload.
 */
import { isPortableRelPath } from './ipc/contract';

export const MAX_SESSION_TABS = 30;

export const FILES_WIDTH = { min: 160, max: 480, default: 220 } as const;
export const EDITOR_SHARE = { min: 0.2, max: 0.8, default: 0.5 } as const;

/** The persisted part of the workbench layout (wide window). */
export interface SessionLayout {
  readonly filesOpen: boolean;
  readonly problemsOpen: boolean;
  /** Width of the files panel in CSS pixels. */
  readonly filesWidth: number;
  /** Fraction of the editor + preview width that the editor gets. */
  readonly editorShare: number;
}

export const DEFAULT_SESSION_LAYOUT: SessionLayout = {
  filesOpen: true,
  problemsOpen: false,
  filesWidth: FILES_WIDTH.default,
  editorShare: EDITOR_SHARE.default,
};

export interface ProjectTabs {
  /** Open files as portable relative paths, in tab order. */
  readonly tabs: readonly string[];
  readonly active: string | null;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const inRange = (value: unknown, min: number, max: number): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;

export function parseSessionLayout(value: unknown): SessionLayout | null {
  if (!isRecord(value)) return null;
  const keys = Object.keys(value).sort().join(',');
  if (keys !== 'editorShare,filesOpen,filesWidth,problemsOpen') return null;
  const { filesOpen, problemsOpen, filesWidth, editorShare } = value;
  if (typeof filesOpen !== 'boolean' || typeof problemsOpen !== 'boolean') return null;
  if (!inRange(filesWidth, FILES_WIDTH.min, FILES_WIDTH.max)) return null;
  if (!inRange(editorShare, EDITOR_SHARE.min, EDITOR_SHARE.max)) return null;
  return { filesOpen, problemsOpen, filesWidth, editorShare };
}

export function parseProjectTabs(value: unknown): ProjectTabs | null {
  if (!isRecord(value)) return null;
  const keys = Object.keys(value).sort().join(',');
  if (keys !== 'active,tabs') return null;
  const { tabs, active } = value;
  if (!Array.isArray(tabs) || tabs.length > MAX_SESSION_TABS || !tabs.every(isPortableRelPath)) return null;
  if (new Set(tabs).size !== tabs.length) return null;
  if (active !== null && !(typeof active === 'string' && tabs.includes(active))) return null;
  return { tabs: [...tabs], active };
}
