/**
 * Payload parsers for the draft channels (S48.7). Main validates every request with these before anything else runs
 * (AGENTS.md "restricted IPC"): exact keys, known values, bounded sizes; `null` = refuse. The draft store reads its
 * files back through `parseDraftFile`, so a damaged or tampered file is handled like a bad payload.
 */
import { NEW_DRAFT_KEY, type AiDraft, type AiDraftChip, type AiStoredDraft } from './ai-draft-contract';
import { CHAT_ID } from './ai-history-parse';
import { isPortableRelPath, isProjectId } from './contract';

export const AI_DRAFT_LIMITS = {
  /** A pasted page or two is a normal draft; far beyond any request the provider takes. */
  promptChars: 200_000,
  chips: 50,
  labelChars: 500,
  /** The text one chip carries (a selection, an annotation). */
  chipTextChars: 400_000,
  /** Drafts kept per file; the least recently changed are dropped first. */
  drafts: 50,
} as const;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function exactKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []) {
  const keys = Object.keys(value);
  return (
    required.every((k) => keys.includes(k) && value[k] !== undefined) &&
    keys.every((k) => required.includes(k) || optional.includes(k))
  );
}

const str = (v: unknown, max: number): v is string => typeof v === 'string' && v.length <= max;
const line = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= 10_000_000;
const time = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0 && v < 8.64e15;

const CHIP_KINDS = ['file', 'selection', 'problem', 'console', 'annotation'] as const;
const TURN_KINDS = ['chat', 'agent'] as const;
const MODES = ['chat', 'explain-code', 'explain-problem'] as const;

export const isDraftKey = (v: unknown): v is string =>
  v === NEW_DRAFT_KEY || (typeof v === 'string' && CHAT_ID.test(v));

function parseChip(raw: unknown): AiDraftChip | null {
  if (!isRecord(raw) || !exactKeys(raw, ['kind'], ['relPath', 'startLine', 'endLine', 'label', 'text'])) return null;
  if (!CHIP_KINDS.includes(raw.kind as 'file')) return null;
  if (raw.relPath !== undefined && !isPortableRelPath(raw.relPath)) return null;
  if (raw.startLine !== undefined && !line(raw.startLine)) return null;
  if (raw.endLine !== undefined && (!line(raw.endLine) || !line(raw.startLine) || raw.endLine < raw.startLine)) {
    return null;
  }
  if (raw.label !== undefined && !str(raw.label, AI_DRAFT_LIMITS.labelChars)) return null;
  if (raw.text !== undefined && !str(raw.text, AI_DRAFT_LIMITS.chipTextChars)) return null;
  return {
    kind: raw.kind as AiDraftChip['kind'],
    ...(raw.relPath !== undefined ? { relPath: raw.relPath as string } : {}),
    ...(raw.startLine !== undefined ? { startLine: raw.startLine as number } : {}),
    ...(raw.endLine !== undefined ? { endLine: raw.endLine as number } : {}),
    ...(raw.label !== undefined ? { label: raw.label as string } : {}),
    ...(raw.text !== undefined ? { text: raw.text as string } : {}),
  };
}

function parseDraftBody(raw: Record<string, unknown>): AiDraft | null {
  if (!str(raw.prompt, AI_DRAFT_LIMITS.promptChars)) return null;
  if (!TURN_KINDS.includes(raw.kind as 'chat') || !MODES.includes(raw.mode as 'chat')) return null;
  if (!Array.isArray(raw.chips) || raw.chips.length > AI_DRAFT_LIMITS.chips) return null;
  const chips: AiDraftChip[] = [];
  for (const c of raw.chips) {
    const chip = parseChip(c);
    if (!chip) return null;
    chips.push(chip);
  }
  return { prompt: raw.prompt, chips, kind: raw.kind as AiDraft['kind'], mode: raw.mode as AiDraft['mode'] };
}

export function parseDraft(raw: unknown): AiDraft | null {
  return isRecord(raw) && exactKeys(raw, ['prompt', 'chips', 'kind', 'mode']) ? parseDraftBody(raw) : null;
}

/** A drafts file as the store wrote it (`version` is checked by the store first): drafts that do not parse are left out. */
export function parseDraftFile(raw: unknown): AiStoredDraft[] | null {
  if (!isRecord(raw) || !exactKeys(raw, ['version', 'drafts']) || !Array.isArray(raw.drafts)) return null;
  const drafts: AiStoredDraft[] = [];
  for (const d of raw.drafts.slice(0, AI_DRAFT_LIMITS.drafts)) {
    if (!isRecord(d) || !exactKeys(d, ['key', 'updatedAt', 'prompt', 'chips', 'kind', 'mode'])) continue;
    if (!isDraftKey(d.key) || !time(d.updatedAt)) continue;
    const body = parseDraftBody(d);
    if (body && !drafts.some((other) => other.key === d.key)) {
      drafts.push({ key: d.key, updatedAt: d.updatedAt, ...body });
    }
  }
  return drafts;
}

const projectOrNull = (v: unknown): v is string | null => v === null || isProjectId(v);

export function parseGetDrafts(payload: unknown): { projectId: string | null } | null {
  return isRecord(payload) &&
    exactKeys(payload, [], ['projectId']) &&
    'projectId' in payload &&
    projectOrNull(payload.projectId)
    ? { projectId: payload.projectId }
    : null;
}

export function parseSaveDraft(
  payload: unknown,
): { projectId: string | null; key: string; draft: AiDraft | null } | null {
  if (!isRecord(payload) || !exactKeys(payload, ['key'], ['projectId', 'draft'])) return null;
  if (!('projectId' in payload) || !('draft' in payload)) return null;
  if (!projectOrNull(payload.projectId) || !isDraftKey(payload.key)) return null;
  if (payload.draft === null) return { projectId: payload.projectId, key: payload.key, draft: null };
  const draft = parseDraft(payload.draft);
  return draft ? { projectId: payload.projectId, key: payload.key, draft } : null;
}
