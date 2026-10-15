import { describe, expect, it } from 'vitest';
import type { PreviewLogEntry } from '../shared/ipc/preview-contract';
import type { ProblemRecord } from '../shared/problem';
import { CROSS_ORIGIN_SCRIPT_ERROR } from './normalize';
import { explain } from './rules';
import { renderExplanation } from './rules/engine';
import { honestyViolations } from './rules/honesty';
import { RuntimeCapture, type RuntimeSnapshot } from './runtime-capture';

const ORIGIN = 'http://127.0.0.1:51734';
const PROJECT = '3f1c2a9e-8b7d-4c6e-9f00-1a2b3c4d5e6f';
const url = (path: string) => `${ORIGIN}/${path.split('/').map(encodeURIComponent).join('/')}`;

/** The raw records the S16.2 e2e run observed for tests/fixtures/预览 运行时 (Electron 44). */
const RAW: readonly PreviewLogEntry[] = [
  {
    source: 'network',
    level: 'error',
    message: '404 GET image',
    url: url('图片/不存在 的图.png'),
    status: 404,
    resourceType: 'image',
    initiator: `${ORIGIN}/`,
    at: 1,
  },
  {
    source: 'network',
    level: 'error',
    message: '404 GET image',
    url: url('图片/背景 缺失.png'),
    status: 404,
    resourceType: 'image',
    initiator: url('样式/主 样式.css'),
    at: 2,
  },
  {
    source: 'exception',
    level: 'error',
    message: "Uncaught SyntaxError: Unexpected token ';'",
    url: url('脚本/语法 错误.js'),
    line: 2,
    at: 3,
  },
  {
    source: 'exception',
    level: 'error',
    message: "Uncaught TypeError: Cannot set properties of null (setting 'textContent')",
    url: url('脚本/同步 异常.js'),
    line: 3,
    at: 4,
  },
  { source: 'console', level: 'error', message: '自定义错误：找不到按钮', url: url('脚本/控制台.js'), line: 2, at: 5 },
  { source: 'console', level: 'warning', message: '自定义警告：图片太大', url: url('脚本/控制台.js'), line: 3, at: 6 },
  { source: 'console', level: 'info', message: '普通日志不是问题', url: url('脚本/控制台.js'), line: 4, at: 7 },
  {
    source: 'exception',
    level: 'error',
    message: 'Uncaught (in promise) Error: 数据加载失败',
    url: url('脚本/未处理 拒绝.js'),
    line: 3,
    at: 8,
  },
  {
    source: 'network',
    level: 'error',
    message: '404 GET xhr',
    url: url('数据/缺失 的数据.json'),
    status: 404,
    resourceType: 'xhr',
    initiator: `${ORIGIN}/`,
    at: 9,
  },
  {
    source: 'network',
    level: 'error',
    message: '404 GET script',
    url: url('脚本/不存在 的模块.js'),
    status: 404,
    resourceType: 'script',
    initiator: url('脚本/模块 缺失.js'),
    at: 10,
  },
  {
    source: 'exception',
    level: 'error',
    message: "Uncaught SyntaxError: The requested module './工具.js' does not provide an export named '相减'",
    url: url('脚本/模块 入口.js'),
    line: 2,
    at: 11,
  },
];

function setup() {
  let clock = 1_000;
  const published: RuntimeSnapshot[] = [];
  const timers: (() => void)[] = [];
  const capture = new RuntimeCapture({
    now: () => clock,
    publish: (s) => published.push(s),
    setTimer: (cb) => timers.push(cb),
    clearTimer: () => undefined,
  });
  const runTimers = () => {
    for (const t of timers.splice(0)) t();
  };
  const advance = (ms: number) => {
    clock += ms;
  };
  const load = () => {
    capture.navigationStarted();
    capture.navigationCommitted();
  };
  capture.sessionStarted({ projectId: PROJECT, origin: ORIGIN });
  load();
  return { capture, published, runTimers, advance, load };
}

const byMessage = (records: readonly ProblemRecord[], text: string) =>
  records.find((r) => r.originalMessage.includes(text));

describe('RuntimeCapture: mapping (S16.2)', () => {
  it('captures syntax errors, exceptions, rejections, console errors and module failures with project paths', () => {
    const { capture } = setup();
    for (const e of RAW) capture.entry(e);
    const records = capture.list();

    expect(byMessage(records, 'Unexpected token')).toMatchObject({
      source: 'runtime',
      code: 'SyntaxError',
      file: '脚本/语法 错误.js',
      line: 2,
    });
    expect(byMessage(records, 'Cannot set properties of null')).toMatchObject({
      source: 'runtime',
      code: 'TypeError',
      file: '脚本/同步 异常.js',
      line: 3,
    });
    expect(byMessage(records, '数据加载失败')).toMatchObject({
      source: 'runtime',
      code: 'unhandledrejection',
      file: '脚本/未处理 拒绝.js',
      line: 3,
    });
    expect(byMessage(records, '自定义错误')).toMatchObject({
      source: 'console',
      severity: 'error',
      file: '脚本/控制台.js',
      line: 2,
    });
    expect(byMessage(records, '自定义警告')).toMatchObject({ source: 'console', severity: 'warning', line: 3 });
    expect(byMessage(records, '普通日志')).toBeUndefined(); // console.log is output, not a problem
    // Module load failures: a missing export (reported with the importing file and line) and a missing module file.
    expect(byMessage(records, 'does not provide an export')).toMatchObject({
      source: 'runtime',
      code: 'SyntaxError',
      file: '脚本/模块 入口.js',
      line: 2,
    });
    expect(records.find((r) => r.resource?.requestedPath === '脚本/不存在 的模块.js')).toMatchObject({
      source: 'resource',
      code: 'resource-failed',
      resource: { status: 404, resourceType: 'script', initiatorFile: '脚本/模块 缺失.js' },
    });
    // Every record carries the project and the preview attribution; the original message is verbatim.
    for (const r of records) {
      expect(r.projectId).toBe(PROJECT);
      expect(r.preview).toEqual(capture.current());
    }
    expect(byMessage(records, '数据加载失败')?.originalMessage).toBe('Uncaught (in promise) Error: 数据加载失败');
  });

  it('an inline <script> in the page is attributed to its index.html', () => {
    const { capture } = setup();
    capture.entry({
      source: 'exception',
      level: 'error',
      message: 'Uncaught ReferenceError: x is not defined',
      url: `${ORIGIN}/`,
      line: 9,
      at: 1,
    });
    capture.entry({
      source: 'exception',
      level: 'error',
      message: 'Uncaught ReferenceError: y is not defined',
      url: url('子 目录/'),
      line: 4,
      at: 2,
    });
    expect(capture.list().map((r) => [r.file, r.line])).toEqual([
      ['index.html', 9],
      ['子 目录/index.html', 4],
    ]);
  });

  it('a module error Chromium reports against the page without a line claims no file', () => {
    const { capture } = setup();
    capture.entry({
      source: 'exception',
      level: 'error',
      message:
        'Uncaught TypeError: Failed to resolve module specifier "lodash". Relative references must start with either "/", "./", or "../".',
      url: `${ORIGIN}/`,
      at: 1,
    });
    const [record] = capture.list();
    expect(record).toMatchObject({ source: 'runtime', code: 'TypeError' });
    expect(record?.file).toBeUndefined();
    expect(record?.data).toBeUndefined();
    expect(explain(record as ProblemRecord).ruleId).toBe('module-import');
  });

  it('ignores records before a session, page notices, and records after the preview stopped', () => {
    const capture = new RuntimeCapture();
    capture.entry(RAW[2] as PreviewLogEntry);
    expect(capture.list()).toEqual([]);
    capture.sessionStarted({ projectId: PROJECT, origin: ORIGIN });
    capture.navigationStarted();
    capture.navigationCommitted();
    capture.entry({ source: 'page-load', level: 'warning', message: 'navigation blocked', url: 'https://x', at: 1 });
    expect(capture.list()).toEqual([]);
    capture.sessionEnded();
    capture.entry(RAW[2] as PreviewLogEntry);
    expect(capture.list()).toEqual([]);
  });

  it('coalesces change notifications and publishes only when something changed', () => {
    const { capture, published, runTimers } = setup();
    runTimers();
    const before = published.length;
    for (const e of RAW) capture.entry(e);
    runTimers();
    expect(published.length).toBe(before + 1); // eleven records, one notification
    expect(published.at(-1)?.records.length).toBe(10);
    runTimers();
    capture.flush();
    expect(published.length).toBe(before + 1); // nothing new
  });

  it('another project starts with an empty list; the same project keeps its records across Stop/Start', () => {
    const { capture } = setup();
    capture.entry(RAW[3] as PreviewLogEntry);
    capture.sessionEnded();
    capture.sessionStarted({ projectId: PROJECT, origin: 'http://127.0.0.1:60000' });
    expect(capture.list()).toHaveLength(1);
    expect(capture.list()[0]?.stale).toBe(true);
    capture.sessionStarted({ projectId: 'another-project', origin: ORIGIN });
    expect(capture.list()).toEqual([]);
  });
});

describe('RuntimeCapture: refresh attribution (S16.3)', () => {
  const thrown = RAW[3] as PreviewLogEntry;
  const syntax = RAW[2] as PreviewLogEntry;

  it('every committed load increments the generation; problems not seen since are stale', () => {
    const { capture, load } = setup();
    expect(capture.current()?.generation).toBe(1);
    capture.entry(thrown);
    capture.entry(syntax);
    expect(capture.list().every((r) => !r.stale)).toBe(true);

    load(); // refresh
    expect(capture.current()?.generation).toBe(2);
    expect(capture.list().every((r) => r.stale)).toBe(true);

    capture.entry({ ...syntax, at: 50 }); // the syntax error happens again after the refresh
    const records = capture.list();
    expect(byMessage(records, 'Unexpected token')).toMatchObject({ count: 2 });
    expect(byMessage(records, 'Unexpected token')?.stale).toBeUndefined();
    expect(byMessage(records, 'Unexpected token')?.last?.preview?.generation).toBe(2);
    expect(byMessage(records, 'Unexpected token')?.preview?.generation).toBe(1); // first occurrence kept
    expect(byMessage(records, 'Cannot set properties')?.stale).toBe(true);
  });

  it('events the old page sends while the next load is in flight belong to the older generation', () => {
    const { capture } = setup();
    capture.navigationStarted(); // refresh requested, new document not committed yet
    capture.entry({ source: 'console', level: 'error', message: '卸载时的错误', url: url('a.js'), line: 1, at: 2 });
    // …except the new document's own request, which is part of the load in flight.
    capture.entry({
      source: 'network',
      level: 'error',
      message: '404 GET mainFrame',
      url: url('不存在.html'),
      status: 404,
      resourceType: 'mainFrame',
      at: 3,
    });
    capture.navigationCommitted();
    const records = capture.list();
    expect(byMessage(records, '卸载时的错误')).toMatchObject({ preview: { generation: 1 }, stale: true });
    expect(byMessage(records, 'mainFrame')).toMatchObject({ preview: { generation: 2 } });
    expect(byMessage(records, 'mainFrame')?.stale).toBeUndefined();
  });

  it('a new preview session (Stop, Start) makes earlier problems stale even at the same generation number', () => {
    const { capture, load } = setup();
    capture.entry(thrown);
    capture.sessionStarted({ projectId: PROJECT, origin: ORIGIN });
    load();
    expect(capture.current()?.generation).toBe(1);
    expect(capture.list()[0]?.stale).toBe(true);
  });

  it('clearResolved removes only stale problems; a refresh is published even without new records', () => {
    const { capture, load, published, runTimers } = setup();
    capture.entry(thrown);
    capture.entry(syntax);
    runTimers();
    load();
    runTimers();
    expect(published.at(-1)?.current?.generation).toBe(2);
    expect(published.at(-1)?.records.every((r) => r.stale)).toBe(true);
    capture.entry({ ...syntax, at: 9 });
    expect(capture.clearResolved()).toBe(1);
    expect(capture.list().map((r) => r.code)).toEqual(['SyntaxError']);
  });
});

describe('RuntimeCapture: resource failures (S16.4)', () => {
  it('records the requested path and the initiator file: the page, a stylesheet, a module', () => {
    const { capture } = setup();
    for (const e of RAW) capture.entry(e);
    const resources = capture.list().filter((r) => r.source === 'resource');
    expect(
      resources.map((r) => [r.resource?.requestedPath, r.resource?.initiatorFile, r.resource?.resourceType]),
    ).toEqual([
      ['图片/不存在 的图.png', 'index.html', 'image'],
      ['图片/背景 缺失.png', '样式/主 样式.css', 'image'],
      ['数据/缺失 的数据.json', 'index.html', 'fetch'],
      ['脚本/不存在 的模块.js', '脚本/模块 缺失.js', 'script'],
    ]);
  });

  it('network errors keep the Chromium error name; requests from other origins have no project path', () => {
    const { capture } = setup();
    capture.entry({
      source: 'network',
      level: 'error',
      message: 'net::ERR_NAME_NOT_RESOLVED GET image',
      url: 'https://example.invalid/%E5%9B%BE.png',
      resourceType: 'image',
      initiator: url('页面/关于.html'),
      at: 1,
    });
    expect(capture.list()[0]).toMatchObject({
      source: 'resource',
      resource: {
        requestedUrl: 'https://example.invalid/%E5%9B%BE.png',
        netError: 'net::ERR_NAME_NOT_RESOLVED',
        initiatorFile: '页面/关于.html',
      },
    });
    expect(capture.list()[0]?.resource?.requestedPath).toBeUndefined();
    expect(capture.list()[0]?.resource?.status).toBeUndefined();
  });
});

describe('RuntimeCapture: volume (S16.5)', () => {
  it('a flood of console errors is rate limited and capped; repeats collapse; runtime errors survive', () => {
    let clock = 0;
    const capture = new RuntimeCapture({ now: () => clock, store: { capacity: { console: 300 } } });
    capture.sessionStarted({ projectId: PROJECT, origin: ORIGIN });
    capture.navigationStarted();
    capture.navigationCommitted();
    capture.entry(RAW[3] as PreviewLogEntry); // a real error first
    for (let i = 0; i < 20_000; i++) {
      clock += 1; // 20 s of 1000 messages per second
      capture.entry({ source: 'console', level: 'error', message: `洪水 ${i}`, url: url('a.js'), line: 1, at: clock });
      capture.entry({ source: 'console', level: 'error', message: '重复的错误', url: url('a.js'), line: 2, at: clock });
    }
    const records = capture.list();
    const consoleRecords = records.filter((r) => r.source === 'console');
    expect(consoleRecords.length).toBeLessThanOrEqual(300);
    const stats = capture.stats();
    expect(stats.dropped.console).toBeGreaterThan(18_000);
    expect(stats.evicted.console).toBeGreaterThan(0);
    const repeated = byMessage(records, '重复的错误');
    expect(repeated).toMatchObject({ count: 20_000, originalMessage: '重复的错误', line: 2 });
    expect(repeated?.last).toMatchObject({ message: '重复的错误', at: 20_000 });
    expect(byMessage(records, 'Cannot set properties')).toMatchObject({ source: 'runtime', count: 1 });
  });
});

describe('RuntimeCapture: cross-origin scripts (S16.6)', () => {
  it('an error in a script from another website has no project location and keeps the script URL', () => {
    const { capture } = setup();
    capture.entry({
      source: 'exception',
      level: 'error',
      message: 'Uncaught Error: 外部库出错',
      url: 'https://cdn.example.com/%E5%A4%96%E9%83%A8%20%E5%BA%93.js',
      line: 3,
      at: 1,
    });
    capture.entry({ source: 'exception', level: 'error', message: 'Script error.', at: 2 });
    const [external, opaque] = capture.list();
    expect(external).toMatchObject({
      source: 'runtime',
      data: { scriptUrl: 'https://cdn.example.com/%E5%A4%96%E9%83%A8%20%E5%BA%93.js' },
    });
    expect(external?.file).toBeUndefined();
    expect(external?.line).toBeUndefined();
    expect(opaque).toMatchObject({ source: 'runtime', code: 'cross-origin-script-error' });
    expect(opaque?.file).toBeUndefined();
  });

  it('both are explained: why there is no location in the project, with no "Go to code"', () => {
    const { capture } = setup();
    capture.entry({
      source: 'exception',
      level: 'error',
      message: 'Uncaught Error: 外部库出错',
      url: 'https://cdn.example.com/lib.js',
      line: 3,
      at: 1,
    });
    capture.entry({ source: 'exception', level: 'error', message: 'Script error.', at: 2 });
    for (const record of capture.list()) {
      const exp = explain(record);
      expect(exp.ruleId).toBe(CROSS_ORIGIN_SCRIPT_ERROR);
      expect(exp.actions.map((a) => a.kind)).toEqual(['show-original']);
      expect(honestyViolations(record, exp)).toEqual([]);
    }
    const [external] = capture.list();
    const zh = renderExplanation('zh-CN', external as ProblemRecord, explain(external as ProblemRecord));
    expect(zh.title).toBe('另一个网站的脚本报告了错误：https://cdn.example.com/lib.js');
    expect(zh.explanation).toContain('无法带你跳到你代码中的某一行');
    expect(zh.explanation).toContain('Script error.');
  });

  it('blob: scripts are not project files', () => {
    const { capture } = setup();
    capture.entry({
      source: 'exception',
      level: 'error',
      message: 'Uncaught Error: x',
      url: `blob:${ORIGIN}/0b6c-4e1d`,
      line: 1,
      at: 1,
    });
    expect(capture.list()[0]?.file).toBeUndefined();
  });
});
