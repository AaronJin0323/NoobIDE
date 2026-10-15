/**
 * Payload parsers for the saved-chat and usage channels (S39). Main validates every request with these before
 * anything else runs (AGENTS.md "restricted IPC"): exact keys, known values, bounded sizes; `null` = refuse. The chat
 * store uses `parseSavedChatFile` on the files it reads back, so a damaged or tampered file is handled like a bad
 * payload. Pure TypeScript, shared by main and tests.
 */
import type {
  AiChatToSave,
  AiSavedChange,
  AiSavedChat,
  AiSavedContextItem,
  AiSavedPart,
  AiSavedTurn,
} from './ai-history-contract';
import { isPortableRelPath, isProjectId } from './contract';

export const AI_HISTORY_LIMITS = {
  titleChars: 200,
  turns: 200,
  promptChars: 32_000,
  contextItems: 50,
  labelChars: 500,
  parts: 2_000,
  textChars: 400_000,
  toolChars: 64,
  summaryChars: 2_000,
  reasonChars: 2_000,
  changes: 200,
  errorCodeChars: 64,
  /** Tokens of one turn (far above any real request). */
  tokens: 1_000_000_000,
  /** The daily budget: at least 1,000 tokens, at most 1,000,000,000. */
  minBudget: 1_000,
  maxBudget: 1_000_000_000,
} as const;

/** Conversation ids are UUIDs chosen by the renderer (crypto.randomUUID). */
export const CHAT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TOOL = /^[\w.-]{1,64}$/;
const ERROR_CODE = /^[\w-]{1,64}$/;

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
const count = (v: unknown): v is number =>
  typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= AI_HISTORY_LIMITS.tokens;
const time = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0 && v < 8.64e15;
export const isChatId = (v: unknown): v is string => typeof v === 'string' && CHAT_ID.test(v);

const CONTEXT_KINDS = ['file', 'selection', 'problem', 'console'] as const;
const CHANGE_KINDS = ['edit', 'create', 'rename', 'delete'] as const;
const TURN_KINDS = ['chat', 'agent'] as const;
const MODES = ['chat', 'explain-code', 'explain-problem'] as const;
const STATUSES = ['done', 'error', 'cancelled'] as const;

function parseContextItem(item: unknown): AiSavedContextItem | null {
  if (!isRecord(item) || !exactKeys(item, ['kind'], ['relPath', 'startLine', 'endLine', 'label'])) return null;
  if (!CONTEXT_KINDS.includes(item.kind as 'file')) return null;
  if (item.relPath !== undefined && !isPortableRelPath(item.relPath)) return null;
  if (item.startLine !== undefined && !line(item.startLine)) return null;
  if (item.endLine !== undefined && (!line(item.endLine) || !line(item.startLine) || item.endLine < item.startLine)) {
    return null;
  }
  if (item.label !== undefined && !str(item.label, AI_HISTORY_LIMITS.labelChars)) return null;
  return {
    kind: item.kind as AiSavedContextItem['kind'],
    ...(item.relPath !== undefined ? { relPath: item.relPath as string } : {}),
    ...(item.startLine !== undefined ? { startLine: item.startLine as number } : {}),
    ...(item.endLine !== undefined ? { endLine: item.endLine as number } : {}),
    ...(item.label !== undefined ? { label: item.label as string } : {}),
  };
}

function parseChange(raw: unknown): AiSavedChange | null {
  if (!isRecord(raw) || !exactKeys(raw, ['kind', 'relPath'], ['to'])) return null;
  if (!CHANGE_KINDS.includes(raw.kind as 'edit') || !isPortableRelPath(raw.relPath)) return null;
  if (raw.kind === 'rename' ? !isPortableRelPath(raw.to) : raw.to !== undefined) return null;
  return {
    kind: raw.kind as AiSavedChange['kind'],
    relPath: raw.relPath,
    ...(raw.kind === 'rename' ? { to: raw.to as string } : {}),
  };
}

function parsePart(raw: unknown): AiSavedPart | null {
  if (!isRecord(raw)) return null;
  switch (raw.kind) {
    case 'text':
      return exactKeys(raw, ['kind', 'text']) && str(raw.text, AI_HISTORY_LIMITS.textChars)
        ? { kind: 'text', text: raw.text }
        : null;
    case 'step':
      return exactKeys(raw, ['kind', 'tool', 'summary']) &&
        str(raw.tool, AI_HISTORY_LIMITS.toolChars) &&
        TOOL.test(raw.tool) &&
        str(raw.summary, AI_HISTORY_LIMITS.summaryChars)
        ? { kind: 'step', tool: raw.tool, summary: raw.summary }
        : null;
    case 'proposal': {
      if (!exactKeys(raw, ['kind', 'reason', 'changes']) || !str(raw.reason, AI_HISTORY_LIMITS.reasonChars)) {
        return null;
      }
      if (!Array.isArray(raw.changes) || raw.changes.length > AI_HISTORY_LIMITS.changes) return null;
      const changes: AiSavedChange[] = [];
      for (const c of raw.changes) {
        const change = parseChange(c);
        if (!change) return null;
        changes.push(change);
      }
      return { kind: 'proposal', reason: raw.reason, changes };
    }
    default:
      return null;
  }
}

function parseTurn(raw: unknown): AiSavedTurn | null {
  if (!isRecord(raw)) return null;
  if (!exactKeys(raw, ['kind', 'mode', 'prompt', 'context', 'status', 'parts'], ['usage', 'errorCode'])) return null;
  if (!TURN_KINDS.includes(raw.kind as 'chat') || !MODES.includes(raw.mode as 'chat')) return null;
  if (!STATUSES.includes(raw.status as 'done') || !str(raw.prompt, AI_HISTORY_LIMITS.promptChars)) return null;
  if (!Array.isArray(raw.context) || raw.context.length > AI_HISTORY_LIMITS.contextItems) return null;
  if (!Array.isArray(raw.parts) || raw.parts.length > AI_HISTORY_LIMITS.parts) return null;
  const context: AiSavedContextItem[] = [];
  for (const c of raw.context) {
    const item = parseContextItem(c);
    if (!item) return null;
    context.push(item);
  }
  const parts: AiSavedPart[] = [];
  for (const p of raw.parts) {
    const part = parsePart(p);
    if (!part) return null;
    parts.push(part);
  }
  let usage: AiSavedTurn['usage'];
  if (raw.usage !== undefined) {
    const u = raw.usage;
    if (!isRecord(u) || !exactKeys(u, ['inputTokens', 'outputTokens'])) return null;
    if (!count(u.inputTokens) || !count(u.outputTokens)) return null;
    usage = { inputTokens: u.inputTokens, outputTokens: u.outputTokens };
  }
  if (
    raw.errorCode !== undefined &&
    !(str(raw.errorCode, AI_HISTORY_LIMITS.errorCodeChars) && ERROR_CODE.test(raw.errorCode))
  ) {
    return null;
  }
  return {
    kind: raw.kind as AiSavedTurn['kind'],
    mode: raw.mode as AiSavedTurn['mode'],
    prompt: raw.prompt,
    context,
    status: raw.status as AiSavedTurn['status'],
    parts,
    ...(usage ? { usage } : {}),
    ...(raw.errorCode !== undefined ? { errorCode: raw.errorCode as string } : {}),
  };
}

function parseChatBody(raw: Record<string, unknown>): AiChatToSave | null {
  if (!isChatId(raw.id) || !str(raw.title, AI_HISTORY_LIMITS.titleChars)) return null;
  if (!Array.isArray(raw.turns) || raw.turns.length === 0 || raw.turns.length > AI_HISTORY_LIMITS.turns) return null;
  const turns: AiSavedTurn[] = [];
  for (const t of raw.turns) {
    const turn = parseTurn(t);
    if (!turn) return null;
    turns.push(turn);
  }
  return { id: raw.id, title: raw.title, turns };
}

export function parseChatToSave(raw: unknown): AiChatToSave | null {
  if (!isRecord(raw) || !exactKeys(raw, ['id', 'title', 'turns'])) return null;
  return parseChatBody(raw);
}

/** A chat file as the store wrote it (`version` is checked by the store before this). */
export function parseSavedChatFile(raw: unknown): AiSavedChat | null {
  if (!isRecord(raw) || !exactKeys(raw, ['version', 'id', 'title', 'createdAt', 'updatedAt', 'turns'])) return null;
  if (!time(raw.createdAt) || !time(raw.updatedAt)) return null;
  const body = parseChatBody(raw);
  return body ? { ...body, createdAt: raw.createdAt, updatedAt: raw.updatedAt } : null;
}

// ── channel payloads ──

export function parseProjectOnly(payload: unknown): { projectId: string } | null {
  return isRecord(payload) && exactKeys(payload, ['projectId']) && isProjectId(payload.projectId)
    ? { projectId: payload.projectId }
    : null;
}

export function parseChatRef(payload: unknown): { projectId: string; chatId: string } | null {
  if (!isRecord(payload) || !exactKeys(payload, ['projectId', 'chatId'])) return null;
  return isProjectId(payload.projectId) && isChatId(payload.chatId)
    ? { projectId: payload.projectId, chatId: payload.chatId }
    : null;
}

export function parseSaveChat(payload: unknown): { projectId: string; chat: AiChatToSave } | null {
  if (!isRecord(payload) || !exactKeys(payload, ['projectId', 'chat']) || !isProjectId(payload.projectId)) return null;
  const chat = parseChatToSave(payload.chat);
  return chat ? { projectId: payload.projectId, chat } : null;
}

/** The usage channel takes no payload. */
export function parseNoPayload(payload: unknown): Record<string, never> | null {
  return payload === undefined || (isRecord(payload) && Object.keys(payload).length === 0) ? {} : null;
}

export function isDailyBudget(v: unknown): v is number {
  return (
    typeof v === 'number' && Number.isInteger(v) && v >= AI_HISTORY_LIMITS.minBudget && v <= AI_HISTORY_LIMITS.maxBudget
  );
}

export function parseSetDailyBudget(payload: unknown): { dailyTokens: number | null } | null {
  if (!isRecord(payload) || !exactKeys(payload, [], ['dailyTokens']) || !('dailyTokens' in payload)) return null;
  const value = payload.dailyTokens;
  return value === null || isDailyBudget(value) ? { dailyTokens: value } : null;
}
