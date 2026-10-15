/**
 * Payload parsers for the AI channels (S31.3): main validates every request from the renderer with these before
 * anything else runs (AGENTS.md "restricted IPC"). Exact keys, known values, bounded sizes; `null` = refuse.
 * Pure TypeScript, shared by main and tests.
 */
import {
  AI_PROVIDERS,
  AI_PURPOSES,
  type AiChatMessage,
  type AiConfig,
  type AiContextItem,
  type AiProposalDecision,
  type AiProviderId,
  type AiRequest,
} from './ai-contract';
import { isPortableRelPath, isProjectId } from './contract';

export const AI_LIMITS = {
  /** API keys are ~100–200 characters. */
  keyLength: 512,
  promptChars: 32_000,
  historyMessages: 200,
  historyMessageChars: 64_000,
  contextItems: 50,
  contextItemChars: 400_000,
  labelChars: 500,
  /** Inline prefix / suffix (already bounded by the renderer). */
  inlineChars: 40_000,
  editChars: 400_000,
  languageIdChars: 64,
  modelIdChars: 128,
  proposalResults: 200,
  errorChars: 2_000,
} as const;

const REQUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PROPOSAL_ID = /^[\w-]{1,128}$/;
const LANGUAGE_ID = /^[\w.+-]{1,64}$/;
const MODEL_ID = /^[\w.:/@-]{0,128}$/;
const LOCALES = ['zh-CN', 'en'] as const;

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
const isLocale = (v: unknown): v is 'zh-CN' | 'en' => LOCALES.includes(v as 'zh-CN');
export const isAiProvider = (v: unknown): v is AiProviderId => AI_PROVIDERS.includes(v as AiProviderId);

export function parseProviderOnly(payload: unknown): { provider: AiProviderId } | null {
  return isRecord(payload) && exactKeys(payload, ['provider']) && isAiProvider(payload.provider)
    ? { provider: payload.provider }
    : null;
}

/** The key is only length-checked here; the key store normalizes it. Never echoed back. */
export function parseSetKey(payload: unknown): { provider: AiProviderId; key: string } | null {
  if (!isRecord(payload) || !exactKeys(payload, ['provider', 'key'])) return null;
  return isAiProvider(payload.provider) && str(payload.key, AI_LIMITS.keyLength)
    ? { provider: payload.provider, key: payload.key }
    : null;
}

export function parseStatusRequest(payload: unknown): { projectId: string | null } | null {
  if (!isRecord(payload) || !exactKeys(payload, [], ['projectId'])) return null;
  const projectId = payload.projectId ?? null;
  return projectId === null || isProjectId(projectId) ? { projectId } : null;
}

export function parseSetConfig(payload: unknown): { config: AiConfig } | null {
  if (!isRecord(payload) || !exactKeys(payload, ['config'])) return null;
  const c = payload.config;
  if (!isRecord(c) || !exactKeys(c, ['enabled', 'provider', 'models', 'inlineCompletions'])) return null;
  if (typeof c.enabled !== 'boolean' || typeof c.inlineCompletions !== 'boolean') return null;
  if (c.provider !== null && !isAiProvider(c.provider)) return null;
  const m = c.models;
  if (!isRecord(m) || !exactKeys(m, AI_PURPOSES)) return null;
  if (!AI_PURPOSES.every((p) => typeof m[p] === 'string' && MODEL_ID.test(m[p]))) return null;
  return {
    config: {
      enabled: c.enabled,
      provider: c.provider,
      inlineCompletions: c.inlineCompletions,
      models: { chat: m.chat as string, agent: m.agent as string, inline: m.inline as string, edit: m.edit as string },
    },
  };
}

export function parseSetConsent(payload: unknown): { projectId: string; allowed: boolean } | null {
  if (!isRecord(payload) || !exactKeys(payload, ['projectId', 'allowed'])) return null;
  return isProjectId(payload.projectId) && typeof payload.allowed === 'boolean'
    ? { projectId: payload.projectId, allowed: payload.allowed }
    : null;
}

export function parseRequestId(payload: unknown): { requestId: string } | null {
  return isRecord(payload) &&
    exactKeys(payload, ['requestId']) &&
    str(payload.requestId, 64) &&
    REQUEST_ID.test(payload.requestId)
    ? { requestId: payload.requestId }
    : null;
}

function parseHistory(raw: unknown): AiChatMessage[] | null {
  if (!Array.isArray(raw) || raw.length > AI_LIMITS.historyMessages) return null;
  const out: AiChatMessage[] = [];
  for (const m of raw) {
    if (!isRecord(m) || !exactKeys(m, ['role', 'text'])) return null;
    if ((m.role !== 'user' && m.role !== 'assistant') || !str(m.text, AI_LIMITS.historyMessageChars)) return null;
    out.push({ role: m.role, text: m.text });
  }
  return out;
}

const CONTEXT_KINDS = ['file', 'selection', 'problem', 'console'] as const;

function parseContext(raw: unknown): AiContextItem[] | null {
  if (!Array.isArray(raw) || raw.length > AI_LIMITS.contextItems) return null;
  const out: AiContextItem[] = [];
  for (const item of raw) {
    if (!isRecord(item) || !exactKeys(item, ['kind'], ['relPath', 'startLine', 'endLine', 'text', 'label']))
      return null;
    if (!CONTEXT_KINDS.includes(item.kind as 'file')) return null;
    if (item.relPath !== undefined && !isPortableRelPath(item.relPath)) return null;
    if (item.startLine !== undefined && !line(item.startLine)) return null;
    if (item.endLine !== undefined && (!line(item.endLine) || !line(item.startLine) || item.endLine < item.startLine)) {
      return null;
    }
    if (item.text !== undefined && !str(item.text, AI_LIMITS.contextItemChars)) return null;
    if (item.label !== undefined && !str(item.label, AI_LIMITS.labelChars)) return null;
    // A file item without text is re-read from disk by main, so it needs a path.
    if (item.text === undefined && item.relPath === undefined) return null;
    out.push({
      kind: item.kind as AiContextItem['kind'],
      ...(item.relPath !== undefined ? { relPath: item.relPath as string } : {}),
      ...(item.startLine !== undefined ? { startLine: item.startLine as number } : {}),
      ...(item.endLine !== undefined ? { endLine: item.endLine as number } : {}),
      ...(item.text !== undefined ? { text: item.text as string } : {}),
      ...(item.label !== undefined ? { label: item.label as string } : {}),
    });
  }
  return out;
}

const CHAT_MODES = ['chat', 'explain-code', 'explain-problem'] as const;

export function parseAiRequest(payload: unknown): AiRequest | null {
  if (!isRecord(payload)) return null;
  switch (payload.kind) {
    case 'chat': {
      if (!exactKeys(payload, ['kind', 'projectId', 'history', 'prompt', 'context', 'locale'], ['mode'])) return null;
      const { projectId, prompt, locale, mode } = payload;
      if (projectId !== null && !isProjectId(projectId)) return null;
      if (!str(prompt, AI_LIMITS.promptChars) || !isLocale(locale)) return null;
      if (mode !== undefined && !CHAT_MODES.includes(mode as 'chat')) return null;
      const history = parseHistory(payload.history);
      const context = parseContext(payload.context);
      if (!history || !context) return null;
      // Without a project there are no files to re-read.
      if (projectId === null && context.some((c) => c.text === undefined)) return null;
      return {
        kind: 'chat',
        projectId,
        history,
        prompt,
        context,
        locale,
        ...(mode !== undefined ? { mode: mode as (typeof CHAT_MODES)[number] } : {}),
      };
    }
    case 'inline': {
      if (!exactKeys(payload, ['kind', 'projectId', 'relPath', 'languageId', 'prefix', 'suffix'])) return null;
      const { projectId, relPath, languageId, prefix, suffix } = payload;
      if (!isProjectId(projectId) || !isPortableRelPath(relPath)) return null;
      if (!str(languageId, AI_LIMITS.languageIdChars) || !LANGUAGE_ID.test(languageId)) return null;
      if (!str(prefix, AI_LIMITS.inlineChars) || !str(suffix, AI_LIMITS.inlineChars)) return null;
      return { kind: 'inline', projectId, relPath, languageId, prefix, suffix };
    }
    case 'edit': {
      const keys = [
        'kind',
        'projectId',
        'relPath',
        'languageId',
        'instruction',
        'selection',
        'before',
        'after',
        'locale',
      ];
      if (!exactKeys(payload, keys)) return null;
      const { projectId, relPath, languageId, instruction, selection, before, after, locale } = payload;
      if (!isProjectId(projectId) || !isPortableRelPath(relPath) || !isLocale(locale)) return null;
      if (!str(languageId, AI_LIMITS.languageIdChars) || !LANGUAGE_ID.test(languageId)) return null;
      if (!str(instruction, AI_LIMITS.promptChars) || instruction.trim() === '') return null;
      if (
        !str(selection, AI_LIMITS.editChars) ||
        !str(before, AI_LIMITS.editChars) ||
        !str(after, AI_LIMITS.editChars)
      ) {
        return null;
      }
      return { kind: 'edit', projectId, relPath, languageId, instruction, selection, before, after, locale };
    }
    case 'agent': {
      if (!exactKeys(payload, ['kind', 'projectId', 'history', 'prompt', 'context', 'locale'])) return null;
      const { projectId, prompt, locale } = payload;
      if (!isProjectId(projectId) || !str(prompt, AI_LIMITS.promptChars) || !isLocale(locale)) return null;
      const history = parseHistory(payload.history);
      const context = parseContext(payload.context);
      if (!history || !context) return null;
      return { kind: 'agent', projectId, history, prompt, context, locale };
    }
    default:
      return null;
  }
}

export function parseProposalDecision(payload: unknown): AiProposalDecision | null {
  if (!isRecord(payload) || !exactKeys(payload, ['requestId', 'proposalId', 'results'])) return null;
  const { requestId, proposalId, results } = payload;
  if (!str(requestId, 64) || !REQUEST_ID.test(requestId) || !str(proposalId, 128) || !PROPOSAL_ID.test(proposalId)) {
    return null;
  }
  if (!Array.isArray(results) || results.length > AI_LIMITS.proposalResults) return null;
  const out: AiProposalDecision['results'][number][] = [];
  for (const r of results) {
    if (!isRecord(r)) return null;
    if (r.accepted === false && exactKeys(r, ['accepted'])) out.push({ accepted: false });
    else if (
      r.accepted === true &&
      exactKeys(r, ['accepted', 'applied'], ['error']) &&
      typeof r.applied === 'boolean'
    ) {
      if (r.error !== undefined && !str(r.error, AI_LIMITS.errorChars)) return null;
      out.push(
        r.error !== undefined
          ? { accepted: true, applied: r.applied, error: r.error as string }
          : { accepted: true, applied: r.applied },
      );
    } else return null;
  }
  return { requestId, proposalId, results: out };
}
