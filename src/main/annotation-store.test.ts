import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AnnotationTarget } from '../shared/ipc/annotations-contract';
import { parseAnnotationTarget, parseContextRequest, parseResolve, parseSave } from '../shared/ipc/annotations-parse';
import { AnnotationStore } from './annotation-store';

const TARGET: AnnotationTarget = {
  kind: 'element',
  pagePath: '页面/首 页.html',
  tag: 'button',
  id: 'send',
  classes: ['cta'],
  text: '发送',
  selector: '#send',
  path: [1, 0],
  ancestry: [{ tag: 'button', nth: 1 }],
  rect: { x: 0, y: 0, width: 10, height: 10 },
  viewport: { width: 800, height: 600 },
  rules: [{ sheet: { kind: 'style', index: 0 }, selector: '#send', occurrence: 1 }],
};

let dir = '';
let seq = 0;
const ROOT = path.join('D:', '项目 一');
const newId = () => `00000000-0000-4000-8000-${String((seq += 1)).padStart(12, '0')}`;
const store = (extra: Partial<ConstructorParameters<typeof AnnotationStore>[0]> = {}) =>
  new AnnotationStore({ dir, newId, now: () => 1_000, ...extra });

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'noobide-annot-store-'));
  seq = 0;
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('AnnotationStore (S41.4)', () => {
  it('adds, lists, updates and removes; the file name is a hash, not a path', async () => {
    const s = store();
    const added = await s.add(ROOT, '把按钮变大', TARGET);
    expect(added).toMatchObject({ ok: true, value: { note: '把按钮变大', target: TARGET, createdAt: 1_000 } });
    expect(await s.list(ROOT)).toHaveLength(1);
    const [name] = await readdir(dir);
    expect(name).toMatch(/^[0-9a-f]+\.json$/);
    const id = added.ok ? added.value.id : '';
    expect(await s.update(ROOT, id, '再大一点')).toMatchObject({ ok: true, value: { note: '再大一点' } });
    expect(await store().get(ROOT, id)).toMatchObject({ note: '再大一点' });
    expect(await s.remove(ROOT, id)).toEqual({ ok: true, value: null });
    expect(await s.list(ROOT)).toEqual([]);
    expect(await s.update(ROOT, id, 'x')).toMatchObject({ ok: false, code: 'not-found' });
  });

  it('keeps at most the per-project limit and caps notes', async () => {
    const s = store({ maxPerProject: 2 });
    await s.add(ROOT, 'a', TARGET);
    const second = await s.add(ROOT, 'b'.repeat(5_000), TARGET);
    expect(second.ok && second.value.note.length).toBe(2_000);
    expect(await s.add(ROOT, 'c', TARGET)).toMatchObject({ ok: false, code: 'too-many' });
  });

  it('moves a damaged file aside and starts empty; drops entries that do not match the format', async () => {
    const s = store();
    await s.add(ROOT, 'a', TARGET);
    const file = s.file(ROOT);
    const text = JSON.parse(await readFile(file, 'utf8')) as { annotations: unknown[] };
    text.annotations.push({ id: 'not-an-id', note: 'x' }, { ...(text.annotations[0] as object), target: { tag: '<x>' } }); // prettier-ignore
    await writeFile(file, JSON.stringify(text));
    expect(await s.list(ROOT)).toHaveLength(1);
    await writeFile(file, '{ broken');
    expect(await s.list(ROOT)).toEqual([]);
    expect((await readdir(dir)).some((n) => n.includes('.corrupt-'))).toBe(true);
    expect(await s.add(ROOT, 'b', TARGET)).toMatchObject({ ok: true });
  });

  it('a file from a newer NoobIDE is read but never written or moved', async () => {
    const s = store();
    await mkdir(dir, { recursive: true });
    const file = s.file(ROOT);
    const newer = JSON.stringify({ version: 9, annotations: [{ id: newId(), note: 'n', createdAt: 1, updatedAt: 1, target: TARGET, extra: 1 }] }); // prettier-ignore
    await writeFile(file, newer);
    expect(await s.list(ROOT)).toHaveLength(1);
    expect(await s.add(ROOT, 'b', TARGET)).toMatchObject({ ok: false, code: 'write-failed' });
    expect(await readFile(file, 'utf8')).toBe(newer);
    await writeFile(file, JSON.stringify({ version: 9, somethingElse: true }));
    expect(await s.list(ROOT)).toEqual([]);
    expect(await readdir(dir)).toHaveLength(1);
  });
});

describe('annotation payload parsers (S41.4)', () => {
  it('accept exactly the contract', () => {
    const id = newId();
    expect(parseSave({ projectId: 'p', pickId: id, note: 'n' })).toEqual({ projectId: 'p', pickId: id, note: 'n' });
    expect(parseSave({ projectId: 'p', pickId: 'x', note: 'n' })).toBeNull();
    expect(parseSave({ projectId: 'p', pickId: id, note: 'n'.repeat(2_001) })).toBeNull();
    expect(parseResolve({ projectId: 'p', how: { kind: 'path', path: [0, 3] } })).toEqual({
      projectId: 'p',
      how: { kind: 'path', path: [0, 3] },
    });
    expect(parseResolve({ projectId: 'p', how: { kind: 'path', path: [-1] } })).toBeNull();
    expect(parseResolve({ projectId: 'p', how: { kind: 'region', x: 0, y: 0, width: 1, height: Number.NaN } })).toBeNull(); // prettier-ignore
    expect(parseContextRequest({ projectId: 'p', ids: [id, id], locale: 'en' })).toEqual({ projectId: 'p', ids: [id], locale: 'en' }); // prettier-ignore
    expect(parseContextRequest({ projectId: 'p', ids: [], locale: 'en' })).toBeNull();
    expect(parseContextRequest({ projectId: 'p', ids: [id], locale: 'fr' })).toBeNull();
  });
  it('a stored target is validated field by field', () => {
    expect(parseAnnotationTarget(TARGET)).toEqual(TARGET);
    expect(parseAnnotationTarget({ ...TARGET, extra: 1 })).toBeNull();
    expect(parseAnnotationTarget({ ...TARGET, path: [1.5] })).toBeNull();
    expect(parseAnnotationTarget({ ...TARGET, rules: [{ sheet: { kind: 'url', path: 'x' }, selector: 'a', occurrence: 1 }] })).toBeNull(); // prettier-ignore
  });
});
