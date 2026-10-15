import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { IpcMainInvokeEvent } from 'electron';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AnnotationStore } from '../../src/main/annotation-store';
import { registerAnnotationsIpcHandlers, type AnnotationPreview } from '../../src/main/annotations-ipc';
import {
  ANNOTATION_CHANNELS,
  type Annotation,
  type AnnotationContext,
  type AnnotationPick,
  type AnnotationTarget,
} from '../../src/shared/ipc/annotations-contract';
import { err, ok } from '../../src/shared/result';

/**
 * S41.4: the annotation IPC handlers over a real store in a temporary app-data folder and a real project folder
 * (Chinese characters and spaces), with a fake preview. Proves the trusted-sender check, owner checks, that a target
 * is saved only by its main-side pickId, that nothing is written into the project, and that listing re-locates
 * annotations against the files on disk.
 */
const ORIGIN = 'noobide://app';
const PROJECT = 'p-1';
type Handler = (event: IpcMainInvokeEvent, ...args: unknown[]) => Promise<unknown>;
const eventFrom = (url: string | null, windowId = 1) =>
  ({ senderFrame: url === null ? null : { url, parent: null }, sender: { id: windowId } }) as unknown as IpcMainInvokeEvent; // prettier-ignore
const workbench = eventFrom(`${ORIGIN}/index.html`);
const otherWindow = eventFrom(`${ORIGIN}/index.html`, 2);

const TARGET: AnnotationTarget = {
  kind: 'element',
  pagePath: '',
  tag: 'button',
  id: 'send',
  classes: ['cta'],
  text: '发送',
  selector: '#send',
  path: [1, 0, 0],
  ancestry: [
    { tag: 'main', nth: 1 },
    { tag: 'button', nth: 1 },
  ],
  rect: { x: 10, y: 20, width: 96, height: 32 },
  viewport: { width: 800, height: 600 },
  rules: [{ sheet: { kind: 'file', path: '样式 表.css' }, selector: '.cta', occurrence: 1 }],
};

const HTML = '<!doctype html>\n<link rel="stylesheet" href="样式 表.css">\n<main>\n  <button id="send" class="cta">发送</button>\n</main>\n'; // prettier-ignore
const CSS = 'body { margin: 0; }\n.cta {\n  padding: 4px 8px;\n}\n';

let tmp = '';
let root = '';
let appData = '';
let handlers: Map<string, Handler>;
let preview: { [K in keyof AnnotationPreview]: ReturnType<typeof vi.fn> };

beforeEach(async () => {
  tmp = await mkdtemp(path.join(tmpdir(), 'noobide-annot-ipc-'));
  root = path.join(tmp, '我的 网页');
  appData = path.join(tmp, 'app data', 'annotations');
  await mkdir(root, { recursive: true });
  await writeFile(path.join(root, 'index.html'), HTML);
  await writeFile(path.join(root, '样式 表.css'), CSS);
  root = await realpath(root);
  handlers = new Map();
  preview = {
    isOwner: vi.fn(({ windowId }: { windowId: number }) => windowId === 1),
    annotationPick: vi.fn(async () => ok(TARGET)),
    annotationCancelPick: vi.fn(),
    annotationCandidates: vi.fn(async () => ok({ items: [{ path: [1, 0, 0], label: 'button#send "发送"' }], truncated: false })), // prettier-ignore
    annotationResolve: vi.fn(async () => ok({ ...TARGET, kind: 'region', region: { x: 0, y: 0, width: 50, height: 20 } })), // prettier-ignore
    annotationHighlight: vi.fn(async () => ok(null)),
    annotationRegionShot: vi.fn(async () => err('not-available', 'hidden')),
  };
  registerAnnotationsIpcHandlers({ handle: (channel: string, h: Handler) => void handlers.set(channel, h) } as never, {
    allowedOrigin: ORIGIN,
    store: new AnnotationStore({ dir: appData, newId: randomUUID }),
    preview: preview as unknown as AnnotationPreview,
    rootOf: (id) => (id === PROJECT ? root : undefined),
    newId: randomUUID,
  });
});

afterEach(async () => {
  if (tmp) await rm(tmp, { recursive: true, force: true });
});

const call = async <T>(channel: string, event: IpcMainInvokeEvent, ...args: unknown[]) => {
  const h = handlers.get(channel);
  if (!h) throw new Error(`no handler for ${channel}`);
  return (await h(event, ...args)) as { ok: true; value: T } | { ok: false; code: string };
};
const value = <T>(result: { ok: true; value: T } | { ok: false; code: string }): T => {
  if (!result.ok) throw new Error(`expected ok, got ${result.code}`);
  return result.value;
};

describe('annotations IPC (S41.4)', () => {
  it('refuses senders that are not the workbench on every channel, before touching anything', async () => {
    for (const channel of Object.values(ANNOTATION_CHANNELS)) {
      for (const event of [eventFrom('http://127.0.0.1:5000/index.html'), eventFrom(null)]) {
        expect(await call(channel, event, { projectId: PROJECT })).toMatchObject({ code: 'forbidden-sender' });
      }
      expect(await call(channel, workbench, { projectId: PROJECT }, 'extra')).toMatchObject({ code: 'invalid-request' }); // prettier-ignore
    }
    for (const fn of Object.values(preview)) expect(fn).not.toHaveBeenCalled();
  });

  it('pick → save → list: the source is located, nothing is written into the project', async () => {
    const pick = value(await call<AnnotationPick>(ANNOTATION_CHANNELS.pick, workbench, { projectId: PROJECT }));
    expect(pick.source).toEqual({
      state: 'found',
      html: { relPath: 'index.html', startLine: 4, endLine: 4, match: 'exact' },
      css: [{ relPath: '样式 表.css', startLine: 2, endLine: 4, match: 'exact', selector: '.cta' }],
    });
    const saved = value(
      await call<Annotation>(ANNOTATION_CHANNELS.save, workbench, {
        projectId: PROJECT,
        pickId: pick.pickId,
        note: '  把这个按钮变大一点 ',
      }),
    );
    expect(saved).toMatchObject({ note: '把这个按钮变大一点', target: TARGET, source: pick.source });
    const list = value(await call<Annotation[]>(ANNOTATION_CHANNELS.list, workbench, { projectId: PROJECT }));
    expect(list.map((a) => a.id)).toEqual([saved.id]);
    expect((await readdir(root)).sort()).toEqual(['index.html', '样式 表.css']);
    expect(await readdir(appData)).toHaveLength(1);
    // A pickId is used once.
    expect(
      await call(ANNOTATION_CHANNELS.save, workbench, { projectId: PROJECT, pickId: pick.pickId, note: 'x' }),
    ).toMatchObject({ code: 'expired' });
  });

  it('a pick of another window, an unknown pickId or another project cannot be saved', async () => {
    const pick = value(await call<AnnotationPick>(ANNOTATION_CHANNELS.pick, workbench, { projectId: PROJECT }));
    expect(
      await call(ANNOTATION_CHANNELS.save, otherWindow, { projectId: PROJECT, pickId: pick.pickId, note: 'x' }),
    ).toMatchObject({ code: 'expired' });
    expect(
      await call(ANNOTATION_CHANNELS.save, workbench, { projectId: PROJECT, pickId: randomUUID(), note: 'x' }),
    ).toMatchObject({ code: 'expired' });
    expect(
      await call(ANNOTATION_CHANNELS.save, workbench, { projectId: 'nope', pickId: pick.pickId, note: 'x' }),
    ).toMatchObject({ code: 'unknown-project' });
    // A target in the payload is not part of the contract.
    expect(
      await call(ANNOTATION_CHANNELS.save, workbench, { projectId: PROJECT, pickId: pick.pickId, note: 'x', target: TARGET }), // prettier-ignore
    ).toMatchObject({ code: 'invalid-request' });
  });

  it('only the window that owns the preview picks, resolves, lists candidates and highlights', async () => {
    for (const [channel, payload] of [
      [ANNOTATION_CHANNELS.pick, { projectId: PROJECT }],
      [ANNOTATION_CHANNELS.candidates, { projectId: PROJECT }],
      [ANNOTATION_CHANNELS.regionShot, { projectId: PROJECT }],
      [ANNOTATION_CHANNELS.resolve, { projectId: PROJECT, how: { kind: 'path', path: [1] } }],
      [ANNOTATION_CHANNELS.highlight, { projectId: PROJECT, id: null }],
    ] as const) {
      expect(await call(channel, otherWindow, payload)).toMatchObject({ code: 'not-owner' });
    }
    expect(preview.annotationPick).not.toHaveBeenCalled();
    expect(preview.annotationHighlight).not.toHaveBeenCalled();
  });

  it('resolve validates regions; a region annotation keeps its rectangle', async () => {
    expect(
      await call(ANNOTATION_CHANNELS.resolve, workbench, {
        projectId: PROJECT,
        how: { kind: 'region', x: 0.1, y: 0.1, width: 2, height: 0.1 },
      }),
    ).toMatchObject({ code: 'invalid-request' });
    const pick = value(
      await call<AnnotationPick>(ANNOTATION_CHANNELS.resolve, workbench, {
        projectId: PROJECT,
        how: { kind: 'region', x: 0.1, y: 0.1, width: 0.2, height: 0.1 },
      }),
    );
    expect(pick.target).toMatchObject({ kind: 'region', region: { width: 50, height: 20 } });
    expect(preview.annotationResolve).toHaveBeenCalledWith(PROJECT, {
      kind: 'region',
      x: 0.1,
      y: 0.1,
      width: 0.2,
      height: 0.1,
    });
  });

  it('listing re-locates against the files on disk (moved lines, removed element)', async () => {
    const pick = value(await call<AnnotationPick>(ANNOTATION_CHANNELS.pick, workbench, { projectId: PROJECT }));
    value(await call(ANNOTATION_CHANNELS.save, workbench, { projectId: PROJECT, pickId: pick.pickId, note: 'n' }));
    await writeFile(path.join(root, 'index.html'), `<!-- new -->\n<!-- lines -->\n${HTML}`);
    let [first] = value(await call<Annotation[]>(ANNOTATION_CHANNELS.list, workbench, { projectId: PROJECT }));
    expect(first?.source.html).toMatchObject({ startLine: 6, match: 'exact' });
    await writeFile(path.join(root, 'index.html'), '<main><p>no button</p></main>');
    [first] = value(await call<Annotation[]>(ANNOTATION_CHANNELS.list, workbench, { projectId: PROJECT }));
    expect(first?.source).toMatchObject({ state: 'not-found', html: null });
  });

  it('update, highlight by id, remove', async () => {
    const pick = value(await call<AnnotationPick>(ANNOTATION_CHANNELS.pick, workbench, { projectId: PROJECT }));
    const saved = value(
      await call<Annotation>(ANNOTATION_CHANNELS.save, workbench, { projectId: PROJECT, pickId: pick.pickId, note: 'a' }), // prettier-ignore
    );
    const updated = value(
      await call<Annotation>(ANNOTATION_CHANNELS.update, workbench, { projectId: PROJECT, id: saved.id, note: 'b' }),
    );
    expect(updated.note).toBe('b');
    value(await call(ANNOTATION_CHANNELS.highlight, workbench, { projectId: PROJECT, id: saved.id }));
    expect(preview.annotationHighlight).toHaveBeenCalledWith(PROJECT, { path: TARGET.path, pagePath: '' });
    value(await call(ANNOTATION_CHANNELS.remove, workbench, { projectId: PROJECT, id: saved.id }));
    expect(await call(ANNOTATION_CHANNELS.remove, workbench, { projectId: PROJECT, id: saved.id })).toMatchObject({
      code: 'not-found',
    });
    const file = (await readdir(appData))[0] ?? '';
    expect(JSON.parse(await readFile(path.join(appData, file), 'utf8'))).toEqual({ version: 1, annotations: [] });
  });

  it('context: the chip text names the file and lines, with numbered excerpts (zh-CN and en)', async () => {
    const pick = value(await call<AnnotationPick>(ANNOTATION_CHANNELS.pick, workbench, { projectId: PROJECT }));
    const saved = value(
      await call<Annotation>(ANNOTATION_CHANNELS.save, workbench, { projectId: PROJECT, pickId: pick.pickId, note: '把这个按钮变大一点' }), // prettier-ignore
    );
    const [zh] = value(
      await call<AnnotationContext[]>(ANNOTATION_CHANNELS.context, workbench, {
        projectId: PROJECT,
        ids: [saved.id],
        locale: 'zh-CN',
      }),
    );
    expect(zh).toMatchObject({
      id: saved.id,
      label: '标注 1：把这个按钮变大一点',
      relPath: 'index.html',
      startLine: 4,
      endLine: 4,
      ranges: [
        { relPath: 'index.html', startLine: 4, endLine: 4 },
        { relPath: '样式 表.css', startLine: 2, endLine: 4 },
      ],
    });
    expect(zh?.text).toContain('用户的要求："把这个按钮变大一点"');
    expect(zh?.text).toContain('HTML 位置：index.html 第 4 行 (确切匹配)');
    expect(zh?.text).toContain('4 |   <button id="send" class="cta">发送</button>');
    expect(zh?.text).toContain('- 样式 表.css 第 2–4 行 (.cta)');
    expect(zh?.text).toContain('3 |   padding: 4px 8px;');
    const [en] = value(
      await call<AnnotationContext[]>(ANNOTATION_CHANNELS.context, workbench, {
        projectId: PROJECT,
        ids: [saved.id],
        locale: 'en',
      }),
    );
    expect(en?.text).toContain('HTML location: index.html line 4 (exact match)');
    expect(en?.text).toContain('Element pointed at: <button id="send" class="cta"> "发送" (selector: #send), 96×32 px on screen'); // prettier-ignore
    expect(
      await call(ANNOTATION_CHANNELS.context, workbench, { projectId: PROJECT, ids: [randomUUID()], locale: 'en' }),
    ).toMatchObject({ code: 'not-found' });
  });
});
