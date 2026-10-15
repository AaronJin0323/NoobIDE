/**
 * Payload parsers of the annotation channels (S41.4) and the validator of stored targets. Pure TypeScript. Each
 * returns null for anything that does not match the contract exactly (extra keys, wrong types, out-of-range values).
 */
import {
  ANNOTATION_LIMITS,
  type AnnotationCssRule,
  type AnnotationRect,
  type AnnotationResolveHow,
  type AnnotationTarget,
} from './annotations-contract';

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function exactKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []) {
  const keys = Object.keys(value);
  return required.every((k) => k in value) && keys.every((k) => required.includes(k) || optional.includes(k));
}

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const isAnnotationId = (v: unknown): v is string => typeof v === 'string' && ID.test(v);
const projectIdOk = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 128;
const str = (v: unknown, max: number): v is string => typeof v === 'string' && v.length <= max;
const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const TAG = /^[a-z][a-z0-9-]{0,39}$/;

export function parseProjectOnly(payload: unknown): { projectId: string } | null {
  if (!isRecord(payload) || !exactKeys(payload, ['projectId']) || !projectIdOk(payload.projectId)) return null;
  return { projectId: payload.projectId };
}

function parsePath(v: unknown): number[] | null {
  if (!Array.isArray(v) || v.length > ANNOTATION_LIMITS.pathDepth) return null;
  return v.every((n) => Number.isInteger(n) && n >= 0 && n < 1_000_000) ? [...(v as number[])] : null;
}

const fraction = (v: unknown): v is number => num(v) && v >= 0 && v <= 1;

export function parseResolve(payload: unknown): { projectId: string; how: AnnotationResolveHow } | null {
  if (!isRecord(payload) || !exactKeys(payload, ['projectId', 'how']) || !projectIdOk(payload.projectId)) return null;
  const how = payload.how;
  if (!isRecord(how)) return null;
  if (how.kind === 'path' && exactKeys(how, ['kind', 'path'])) {
    const path = parsePath(how.path);
    return path ? { projectId: payload.projectId, how: { kind: 'path', path } } : null;
  }
  if (how.kind === 'region' && exactKeys(how, ['kind', 'x', 'y', 'width', 'height'])) {
    const { x, y, width, height } = how;
    if (!fraction(x) || !fraction(y) || !fraction(width) || !fraction(height)) return null;
    return { projectId: payload.projectId, how: { kind: 'region', x, y, width, height } };
  }
  return null;
}

export function parseSave(payload: unknown): { projectId: string; pickId: string; note: string } | null {
  if (!isRecord(payload) || !exactKeys(payload, ['projectId', 'pickId', 'note'])) return null;
  const { projectId, pickId, note } = payload;
  if (!projectIdOk(projectId) || !isAnnotationId(pickId) || !str(note, ANNOTATION_LIMITS.noteChars)) return null;
  return { projectId, pickId, note };
}

export function parseUpdate(payload: unknown): { projectId: string; id: string; note: string } | null {
  if (!isRecord(payload) || !exactKeys(payload, ['projectId', 'id', 'note'])) return null;
  const { projectId, id, note } = payload;
  if (!projectIdOk(projectId) || !isAnnotationId(id) || !str(note, ANNOTATION_LIMITS.noteChars)) return null;
  return { projectId, id, note };
}

export function parseRemove(payload: unknown): { projectId: string; id: string } | null {
  if (!isRecord(payload) || !exactKeys(payload, ['projectId', 'id'])) return null;
  const { projectId, id } = payload;
  return projectIdOk(projectId) && isAnnotationId(id) ? { projectId, id } : null;
}

export function parseHighlight(payload: unknown): { projectId: string; id: string | null } | null {
  if (!isRecord(payload) || !exactKeys(payload, ['projectId', 'id'])) return null;
  const { projectId, id } = payload;
  if (!projectIdOk(projectId) || (id !== null && !isAnnotationId(id))) return null;
  return { projectId, id };
}

export function parseContextRequest(
  payload: unknown,
): { projectId: string; ids: string[]; locale: 'zh-CN' | 'en' } | null {
  if (!isRecord(payload) || !exactKeys(payload, ['projectId', 'ids', 'locale'])) return null;
  const { projectId, ids, locale } = payload;
  if (!projectIdOk(projectId) || (locale !== 'zh-CN' && locale !== 'en')) return null;
  if (!Array.isArray(ids) || ids.length === 0 || ids.length > 20 || !ids.every(isAnnotationId)) return null;
  return { projectId, ids: [...new Set(ids)], locale };
}

function parseRect(v: unknown): AnnotationRect | null {
  if (!isRecord(v) || !exactKeys(v, ['x', 'y', 'width', 'height'])) return null;
  const { x, y, width, height } = v;
  return num(x) && num(y) && num(width) && num(height) && width >= 0 && height >= 0 ? { x, y, width, height } : null;
}

function parseRule(v: unknown): AnnotationCssRule | null {
  if (!isRecord(v) || !exactKeys(v, ['sheet', 'selector', 'occurrence'])) return null;
  const { sheet, selector, occurrence } = v;
  if (!str(selector, ANNOTATION_LIMITS.ruleSelectorChars) || !selector) return null;
  if (!Number.isInteger(occurrence) || (occurrence as number) < 1) return null;
  if (!isRecord(sheet)) return null;
  if (sheet.kind === 'file' && exactKeys(sheet, ['kind', 'path']) && str(sheet.path, ANNOTATION_LIMITS.pagePathChars)) {
    return { sheet: { kind: 'file', path: sheet.path }, selector, occurrence: occurrence as number };
  }
  if (sheet.kind === 'style' && exactKeys(sheet, ['kind', 'index']) && Number.isInteger(sheet.index)) {
    const index = sheet.index as number;
    return index >= 0 ? { sheet: { kind: 'style', index }, selector, occurrence: occurrence as number } : null;
  }
  return null;
}

/** A stored target (app data is read back like any untrusted file). */
export function parseAnnotationTarget(v: unknown): AnnotationTarget | null {
  if (!isRecord(v)) return null;
  const required = ['kind', 'pagePath', 'tag', 'classes', 'text', 'selector', 'path', 'ancestry', 'rect', 'viewport', 'rules']; // prettier-ignore
  if (!exactKeys(v, required, ['id', 'region'])) return null;
  const L = ANNOTATION_LIMITS;
  if (v.kind !== 'element' && v.kind !== 'region') return null;
  if (!str(v.pagePath, L.pagePathChars) || typeof v.tag !== 'string' || !TAG.test(v.tag)) return null;
  if (v.id !== undefined && (!str(v.id, L.idChars + 1) || !v.id)) return null;
  if (!Array.isArray(v.classes) || v.classes.length > L.classes) return null;
  if (!v.classes.every((c) => str(c, L.classChars) && c)) return null;
  if (!str(v.text, L.textChars + 1) || !str(v.selector, L.selectorChars + 1)) return null;
  const path = parsePath(v.path);
  if (!path || !Array.isArray(v.ancestry) || v.ancestry.length > L.pathDepth) return null;
  const ancestry = [];
  for (const s of v.ancestry) {
    if (!isRecord(s) || !exactKeys(s, ['tag', 'nth']) || typeof s.tag !== 'string' || !TAG.test(s.tag)) return null;
    if (!Number.isInteger(s.nth) || (s.nth as number) < 1) return null;
    ancestry.push({ tag: s.tag, nth: s.nth as number });
  }
  const rect = parseRect(v.rect);
  const vp = v.viewport;
  if (!rect || !isRecord(vp) || !exactKeys(vp, ['width', 'height']) || !num(vp.width) || !num(vp.height)) return null;
  const region = v.region === undefined ? undefined : parseRect(v.region);
  if (region === null) return null;
  if (!Array.isArray(v.rules) || v.rules.length > L.rules) return null;
  const rules = v.rules.map(parseRule);
  if (rules.some((r) => r === null)) return null;
  return {
    kind: v.kind,
    pagePath: v.pagePath,
    tag: v.tag,
    ...(typeof v.id === 'string' ? { id: v.id } : {}),
    classes: v.classes as string[],
    text: v.text,
    selector: v.selector,
    path,
    ancestry,
    rect,
    viewport: { width: vp.width, height: vp.height },
    ...(region ? { region } : {}),
    rules: rules as AnnotationCssRule[],
  };
}
