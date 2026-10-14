import { describe, expect, it } from 'vitest';
import type { PreviewEvent, PreviewLogEntry } from '../../shared/ipc/preview-contract';
import type { ProblemRecord } from '../../shared/problem';
import { bridgeRuntimeSource, previewEventsRuntimeSource, runtimeSourceFor, type RuntimeProblemsApi } from './sources';

const PROJECT = '0a1b2c3d-1111-4222-8333-944455556666';
const ORIGIN = 'http://127.0.0.1:51734';

function fakePreview() {
  let listener: ((event: PreviewEvent) => void) | null = null;
  return {
    api: {
      onEvent: (l: (event: PreviewEvent) => void) => {
        listener = l;
        return () => {
          listener = null;
        };
      },
    },
    emit: (event: PreviewEvent) => listener?.(event),
    status: (state: 'starting' | 'running' | 'refreshing' | 'stopped', projectId: string | null = PROJECT) =>
      listener?.({
        kind: 'status',
        status: { state, projectId, ...(projectId ? { url: `${ORIGIN}/index.html` } : {}) },
      }),
    log: (...entries: PreviewLogEntry[]) => listener?.({ kind: 'log', entries, dropped: 0, throttled: false }),
  };
}

const exception = (message: string, at: number): PreviewLogEntry => ({
  source: 'exception',
  level: 'error',
  message,
  url: `${ORIGIN}/script.js`,
  line: 12,
  at,
});

function setup() {
  const preview = fakePreview();
  let t = 1000;
  const timers: (() => void)[] = [];
  const source = previewEventsRuntimeSource(preview.api, {
    now: () => t,
    setTimer: (callback) => timers.push(callback),
  });
  const seen: (readonly ProblemRecord[])[] = [];
  source.subscribe((records) => seen.push(records));
  const flush = () => {
    for (const callback of timers.splice(0)) callback();
  };
  return { preview, source, seen, flush, tick: (ms: number) => (t += ms) };
}

describe('runtime problems from the preview event stream (S17.1 fallback until S16 lands)', () => {
  it('turns page errors into runtime records attributed to the preview generation', () => {
    const { preview, seen, flush } = setup();
    preview.status('starting');
    preview.status('running');
    preview.log(exception('Uncaught ReferenceError: userNmae is not defined', 1));
    preview.log({
      source: 'network',
      level: 'error',
      message: '404 GET image',
      url: `${ORIGIN}/图片/a.png`,
      status: 404,
      resourceType: 'image',
      at: 2,
    });
    flush();
    const records = seen.at(-1) ?? [];
    expect(records.map((r) => `${r.source}:${r.code}:${r.file ?? r.resource?.requestedPath}`)).toEqual([
      'runtime:ReferenceError:script.js',
      'resource:resource-failed:图片/a.png',
    ]);
    expect(records[0]).toMatchObject({ projectId: PROJECT, line: 12, preview: { generation: 1 } });
    expect(records.some((r) => r.stale)).toBe(false);
  });

  it('dedupes repeats and marks problems stale after a refresh until they occur again', async () => {
    const { preview, source, seen, flush } = setup();
    preview.status('starting');
    preview.status('running');
    preview.log(exception('Uncaught ReferenceError: userNmae is not defined', 1));
    preview.log(exception('Uncaught ReferenceError: userNmae is not defined', 2));
    flush();
    expect(seen.at(-1)?.[0]?.count).toBe(2);
    preview.status('refreshing');
    preview.status('running');
    flush();
    expect(seen.at(-1)?.[0]?.stale).toBe(true);
    await source.clearResolved();
    expect(seen.at(-1)).toEqual([]);
  });

  it('a problem that happens again after the refresh is not stale', () => {
    const { preview, seen, flush } = setup();
    preview.status('starting');
    preview.status('running');
    preview.log(exception('Uncaught TypeError: x is not a function', 1));
    preview.status('refreshing');
    preview.status('running');
    preview.log(exception('Uncaught TypeError: x is not a function', 5));
    flush();
    expect(seen.at(-1)?.[0]).toMatchObject({ count: 2 });
    expect(seen.at(-1)?.[0]?.stale).toBeUndefined();
  });

  it('ignores records while no preview runs, and info output is not a problem', () => {
    const { preview, seen, flush } = setup();
    preview.log(exception('Uncaught Error: early', 1));
    preview.status('starting');
    preview.log({ source: 'console', level: 'info', message: 'hello', at: 2 });
    flush();
    expect(seen.at(-1)).toEqual([]);
  });

  it('a different project starts from an empty list', () => {
    const { preview, seen, flush } = setup();
    preview.status('starting');
    preview.log(exception('Uncaught Error: a', 1));
    preview.status('stopped', null);
    preview.status('starting', '0a1b2c3d-1111-4222-8333-000000000000');
    flush();
    expect(seen.at(-1)).toEqual([]);
  });
});

describe('the S16 bridge API is used when present', () => {
  it('publishes the list and later changes, and forwards clearResolved', async () => {
    let push: ((records: readonly ProblemRecord[]) => void) | null = null;
    let cleared = 0;
    const record = { id: 'p1' } as ProblemRecord;
    const api: RuntimeProblemsApi = {
      list: async () => ({ ok: true, value: [record] }),
      onChanged: (listener) => {
        push = listener;
        return () => (push = null);
      },
      clearResolved: async () => {
        cleared += 1;
        return { ok: true, value: null };
      },
    };
    const source = bridgeRuntimeSource(api);
    const seen: (readonly ProblemRecord[])[] = [];
    source.subscribe((r) => seen.push(r));
    await Promise.resolve();
    await Promise.resolve();
    expect(seen.at(-1)).toEqual([record]);
    (push as unknown as (records: readonly ProblemRecord[]) => void)([]);
    expect(seen.at(-1)).toEqual([]);
    await source.clearResolved();
    expect(cleared).toBe(1);
  });

  it('runtimeSourceFor prefers the bridge API and falls back to preview events', () => {
    const preview = fakePreview().api;
    const api: RuntimeProblemsApi = {
      list: async () => ({ ok: true, value: [] }),
      onChanged: () => () => undefined,
      clearResolved: async () => undefined,
    };
    expect(runtimeSourceFor({ preview, problems: api })?.kind).toBe('bridge');
    expect(runtimeSourceFor({ preview })?.kind).toBe('preview-events');
    expect(runtimeSourceFor(undefined)).toBeNull();
  });
});
