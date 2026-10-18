import { describe, expect, it } from 'vitest';
import { en } from '../i18n/en';
import { zhCN } from '../i18n/zh-CN';
import { PREVIEW_RELOAD_REASONS, type PreviewLogEntry, type PreviewStatus } from '../../shared/ipc/preview-contract';
import {
  EMPTY_LOG,
  MAX_VISIBLE_LOG_ENTRIES,
  STOPPED,
  actionsFor,
  appendLogBatch,
  clearLog,
  errorCount,
  nextGeneration,
  olderCount,
  arrivedPage,
  pageLocation,
  visibleLog,
  previewNotUpdated,
  saveUpdateNote,
  stageMessageKey,
  stateLabelKey,
  viewVisible,
} from './preview-model';

const ID = '3f1c2a9e-8b7d-4c6e-9f00-1a2b3c4d5e6f';
const status = (state: PreviewStatus['state'], failure?: PreviewStatus['failure']): PreviewStatus => ({
  state,
  projectId: state === 'stopped' ? null : ID,
  ...(failure ? { failure } : {}),
});
const entry = (n: number): PreviewLogEntry => ({ source: 'console', level: 'info', message: `m${n}`, at: n });

describe('preview pane model (S04.3, S05.2, S05.3)', () => {
  it('has a label for every state', () => {
    for (const s of ['stopped', 'starting', 'running', 'refreshing', 'unresponsive', 'failed'] as const) {
      expect(stateLabelKey(s)).toMatch(/^preview\./);
    }
  });

  it('S14.1: shows every state as its own text in both languages (never by colour alone)', () => {
    const states = ['stopped', 'starting', 'running', 'refreshing', 'unresponsive', 'failed'] as const;
    for (const dict of [zhCN, en]) {
      const texts = states.map((s) => dict[stateLabelKey(s)]);
      expect(texts.every((text) => text.trim().length > 0)).toBe(true);
      expect(new Set(texts).size).toBe(states.length);
    }
  });

  it('offers Stop in every live state and above all when unresponsive', () => {
    expect(actionsFor(status('unresponsive'), true)).toEqual({ start: false, stop: true, reload: false });
    expect(actionsFor(status('starting'), true)).toEqual({ start: false, stop: true, reload: false });
    expect(actionsFor(status('running'), true)).toEqual({ start: false, stop: true, reload: true });
    expect(actionsFor(STOPPED, true)).toEqual({ start: true, stop: false, reload: false });
    expect(actionsFor(STOPPED, false)).toEqual({ start: false, stop: false, reload: false });
    expect(actionsFor(status('failed', 'crashed'), true)).toEqual({ start: true, stop: true, reload: false });
    expect(actionsFor(status('failed', 'load-failed'), true)).toEqual({ start: true, stop: true, reload: true });
  });

  it('hides the native view while a message must be readable', () => {
    expect(viewVisible(status('running'), true)).toBe(true);
    expect(viewVisible(status('running'), false)).toBe(false);
    expect(viewVisible(status('unresponsive'), true)).toBe(false);
    expect(viewVisible(STOPPED, true)).toBe(false);
    expect(stageMessageKey(status('unresponsive'), true)).toBe('preview.unresponsiveDetail');
    expect(stageMessageKey(STOPPED, true)).toBe('preview.startHint');
    expect(stageMessageKey(STOPPED, false)).toBe('preview.hint');
  });

  it('says "preview not updated" while a save has failed and a page is shown (S10.5)', () => {
    expect(previewNotUpdated(status('running'), true)).toBe(true);
    expect(previewNotUpdated(status('refreshing'), true)).toBe(true);
    expect(previewNotUpdated(status('running'), false)).toBe(false);
    expect(previewNotUpdated(STOPPED, true)).toBe(false);
    expect(previewNotUpdated(status('unresponsive'), true)).toBe(false);
  });

  it('keeps the newest log entries and sums dropped counts', () => {
    let view = appendLogBatch(EMPTY_LOG, [entry(1), entry(2)], 0);
    view = appendLogBatch(view, [], 500);
    view = appendLogBatch(
      view,
      Array.from({ length: MAX_VISIBLE_LOG_ENTRIES }, (_, i) => entry(i + 3)),
      7,
    );
    expect(view.entries).toHaveLength(MAX_VISIBLE_LOG_ENTRIES);
    expect(view.entries[0]?.message).toBe('m3');
    expect(view.dropped).toBe(507);
  });
});

describe('console view model (S17.3)', () => {
  const line = (level: PreviewLogEntry['level'], message: string): PreviewLogEntry => ({
    source: 'console',
    level,
    message,
    at: 1,
  });

  it('attributes lines to the page load they came from; a refresh starts a new one', () => {
    let view = appendLogBatch(nextGeneration(EMPTY_LOG), [line('info', 'first load')], 0);
    view = nextGeneration(view);
    view = appendLogBatch(view, [line('error', 'second load')], 0);
    expect(view.entries.map((e) => `${e.generation}:${e.message}`)).toEqual(['1:first load', '2:second load']);
    expect(visibleLog(view, 'all', false).map((e) => e.message)).toEqual(['second load']);
    expect(visibleLog(view, 'all', true).map((e) => e.message)).toEqual(['first load', 'second load']);
    expect(olderCount(view)).toBe(1);
    // The console heading counts the errors of the current page load only.
    expect(errorCount(view)).toBe(1);
    expect(errorCount(nextGeneration(view))).toBe(0);
    expect(errorCount(EMPTY_LOG)).toBe(0);
  });

  it('console heading and error count are translated in both locales', () => {
    for (const dict of [zhCN, en]) {
      expect(dict['preview.console'].trim()).not.toBe('');
      expect(dict['preview.console.errors']).toContain('{count}');
    }
  });

  it('filters by level (info includes debug)', () => {
    const view = appendLogBatch(
      EMPTY_LOG,
      [line('debug', 'd'), line('info', 'i'), line('warning', 'w'), line('error', 'e')],
      0,
    );
    expect(visibleLog(view, 'error', false).map((e) => e.message)).toEqual(['e']);
    expect(visibleLog(view, 'warning', false).map((e) => e.message)).toEqual(['w']);
    expect(visibleLog(view, 'info', false).map((e) => e.message)).toEqual(['d', 'i']);
    expect(visibleLog(view, 'all', false)).toHaveLength(4);
  });

  it('clear empties the list and the dropped counters but keeps the page load', () => {
    let view = nextGeneration(nextGeneration(EMPTY_LOG));
    view = appendLogBatch(view, [line('info', 'x')], 7, true);
    expect(clearLog(view)).toEqual({ entries: [], dropped: 0, throttled: false, generation: 2 });
  });

  it('stays capped across page loads', () => {
    let view = EMPTY_LOG;
    for (let g = 0; g < 3; g += 1) {
      view = nextGeneration(view);
      view = appendLogBatch(
        view,
        Array.from({ length: MAX_VISIBLE_LOG_ENTRIES }, (_, i) => entry(i)),
        0,
      );
    }
    expect(view.entries).toHaveLength(MAX_VISIBLE_LOG_ENTRIES);
    expect(olderCount(view)).toBe(0);
  });
});

describe('page location in the preview toolbar', () => {
  const at = (url: string | undefined, notFound = false): PreviewStatus => ({
    ...status('running'),
    ...(url ? { url } : {}),
    ...(notFound ? { notFound } : {}),
  });
  const origin = 'http://127.0.0.1:51734';
  it('names the page showing and offers the way back only away from the entry page', () => {
    expect(pageLocation(at(`${origin}/`), 'index.html')).toEqual({ path: 'index.html', missing: false, away: false });
    expect(pageLocation(at(`${origin}/index.html`), 'index.html')?.away).toBe(false);
    expect(pageLocation(at(`${origin}/about.html`), 'index.html')).toEqual({
      path: 'about.html',
      missing: false,
      away: true,
    });
    expect(pageLocation(at(`${origin}/%E5%85%B3%E4%BA%8E%20%E6%88%91.html`), 'index.html')?.path).toBe('关于 我.html');
    expect(pageLocation(at(`${origin}/docs/`), 'docs/index.html')?.away).toBe(false);
  });
  it('a missing page is always away (even when it is the entry), and nothing shows without a page', () => {
    expect(pageLocation(at(`${origin}/about.html`, true), 'index.html')).toEqual({
      path: 'about.html',
      missing: true,
      away: true,
    });
    expect(pageLocation(at(`${origin}/`, true), '')?.away).toBe(true);
    expect(pageLocation(at(`${origin}/about.html`), '')?.away).toBe(false); // entry not known yet
    expect(pageLocation(at(undefined), 'index.html')).toBeNull();
    expect(pageLocation(STOPPED, 'index.html')).toBeNull();
  });
  it('S15.8: a navigation to another existing page is an arrival the editor follows; nothing else is', () => {
    const page = (path: string, missing = false) => ({ path, missing, away: path !== 'index.html' || missing });
    expect(arrivedPage(page('index.html'), page('about.html'))).toBe('about.html');
    expect(arrivedPage(page('about.html'), page('index.html'))).toBe('index.html'); // back, or "Back to entry page"
    expect(arrivedPage(page('index.html'), page('关于 我/页面.html'))).toBe('关于 我/页面.html');
    expect(arrivedPage(null, page('index.html'))).toBeNull(); // the first page of a start
    expect(arrivedPage(page('index.html'), page('index.html'))).toBeNull(); // a refresh or a #hash
    expect(arrivedPage(page('index.html'), page('gone.html', true))).toBeNull(); // no file behind a 404
    expect(arrivedPage(page('gone.html', true), page('gone.html'))).toBeNull(); // the same page, created meanwhile
    expect(arrivedPage(page('index.html'), null)).toBeNull(); // stopped
  });
});

describe('save update note (S54, decision 0040)', () => {
  const running: PreviewStatus = { state: 'running', projectId: 'p', generation: 3 };

  it('says in words whether the styles were swapped or the page reloaded, and why', () => {
    expect(saveUpdateNote(running)).toBeNull();
    expect(saveUpdateNote({ ...running, saveUpdate: { kind: 'styles', seq: 1 } })).toEqual({
      kind: 'styles',
      label: 'preview.update.styles',
      detail: 'preview.update.stylesDetail',
    });
    expect(saveUpdateNote({ ...running, saveUpdate: { kind: 'reload', reason: 'syntax', seq: 2 } })).toEqual({
      kind: 'reload',
      label: 'preview.update.reload',
      detail: 'preview.update.reason.syntax',
    });
    expect(saveUpdateNote({ ...STOPPED, saveUpdate: { kind: 'styles', seq: 1 } })).toBeNull();
  });

  it('every reason has zh-CN and en wording', () => {
    for (const reason of PREVIEW_RELOAD_REASONS) {
      const note = saveUpdateNote({ ...running, saveUpdate: { kind: 'reload', reason, seq: 1 } });
      expect(note && zhCN[note.detail]).toBeTruthy();
      expect(note && en[note.detail]).toBeTruthy();
      expect(note && zhCN[note.detail]).not.toBe(note && en[note.detail]);
    }
    expect(zhCN['preview.update.styles']).toBe('样式已更新（页面没有重新加载）');
    expect(en['preview.update.styles']).toBe('Styles updated (page not reloaded)');
    expect(zhCN['preview.update.reload']).toBe('页面已重新加载');
    expect(en['preview.update.reload']).toBe('Page reloaded');
  });
});
