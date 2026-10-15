import { Script } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { ElementPicker, type PickContents } from './element-pick';
import {
  candidatesExpression,
  clampRegion,
  describeFunction,
  elementAtPathExpression,
  elementInRegionExpression,
  parseCandidates,
  parseTarget,
} from './element-target';

type Listener = (event: unknown, method: string, params: unknown, sessionId?: string) => void;

/** A fake protocol session: records commands, answers them, and lets the test emit events. */
function fakeContents(answers: Record<string, (params: Record<string, unknown>) => unknown> = {}) {
  const commands: { method: string; params: Record<string, unknown> }[] = [];
  const listeners = new Set<Listener>();
  let attached = true;
  const contents: PickContents = {
    isDestroyed: () => false,
    debugger: {
      isAttached: () => attached,
      sendCommand: async (method: string, params: object = {}) => {
        commands.push({ method, params: params as Record<string, unknown> });
        const answer = answers[method];
        if (answer) return answer(params as Record<string, unknown>);
        if (method === 'Target.getTargetInfo') return { targetInfo: { targetId: 'F1' } };
        if (method === 'Page.createIsolatedWorld') return { executionContextId: 7 };
        if (method === 'DOM.resolveNode') return { object: { objectId: 'obj-1' } };
        if (method === 'Runtime.callFunctionOn') return { result: { value: { tag: 'button' } } };
        if (method === 'Runtime.evaluate') return { result: { objectId: 'obj-2', subtype: 'node' } };
        return {};
      },
      on: (_e, l) => listeners.add(l),
      off: (_e, l) => listeners.delete(l),
    },
  };
  const emit = (method: string, params: unknown, sessionId?: string) => {
    for (const l of [...listeners]) l({}, method, params, sessionId);
  };
  const flush = () => new Promise((r) => setTimeout(r, 0));
  return { contents, commands, emit, flush, listeners, detach: () => (attached = false) };
}

const methods = (commands: { method: string }[]) => commands.map((c) => c.method);

describe('ElementPicker (S41.3)', () => {
  it('picks with the protocol inspect mode and describes the node in an isolated world', async () => {
    const fake = fakeContents();
    const picker = new ElementPicker(fake.contents);
    const result = picker.pick();
    await fake.flush();
    expect(picker.isPicking).toBe(true);
    expect(fake.commands.find((c) => c.method === 'Overlay.setInspectMode')?.params.mode).toBe('searchForNode');
    // A child target's event (with a session id) is not the page's pick.
    fake.emit('Overlay.inspectNodeRequested', { backendNodeId: 99 }, 'child-session');
    fake.emit('Overlay.inspectNodeRequested', { backendNodeId: 42 });
    expect(await result).toEqual({ ok: true, value: { tag: 'button' } });
    expect(picker.isPicking).toBe(false);
    const resolve = fake.commands.find((c) => c.method === 'DOM.resolveNode');
    expect(resolve?.params).toEqual({ backendNodeId: 42, executionContextId: 7 });
    expect(fake.commands.find((c) => c.method === 'Page.createIsolatedWorld')?.params).toMatchObject({
      grantUniveralAccess: false,
    });
    const call = fake.commands.find((c) => c.method === 'Runtime.callFunctionOn');
    expect(call?.params).toMatchObject({ objectId: 'obj-1', returnByValue: true, userGesture: false });
    // Inspect mode off, domains disabled again, listener gone.
    const order = methods(fake.commands);
    expect(order.lastIndexOf('Overlay.setInspectMode')).toBeGreaterThan(order.indexOf('Overlay.setInspectMode'));
    expect(order.slice(-2)).toEqual(['Overlay.disable', 'DOM.disable']);
    expect(fake.listeners.size).toBe(0);
  });

  it('cancel ends pick mode; a second pick meanwhile is busy', async () => {
    const fake = fakeContents();
    const picker = new ElementPicker(fake.contents);
    const first = picker.pick();
    expect(await picker.pick()).toEqual({ ok: false, reason: 'busy' });
    await fake.flush();
    picker.cancel();
    expect(await first).toEqual({ ok: false, reason: 'cancelled' });
    expect(methods(fake.commands)).not.toContain('DOM.resolveNode');
    expect(methods(fake.commands)).toContain('DOM.disable');
  });

  it('times out by itself', async () => {
    const fake = fakeContents();
    const picker = new ElementPicker(fake.contents, { pickTimeoutMs: 20, commandTimeoutMs: 100, highlightMs: 10 });
    expect(await picker.pick()).toEqual({ ok: false, reason: 'cancelled' });
  });

  it('a node that cannot be resolved (another frame) is not available; no protocol is not available', async () => {
    const fake = fakeContents({
      'DOM.resolveNode': () => {
        throw new Error('Node with given id does not belong to the document');
      },
    });
    const picker = new ElementPicker(fake.contents);
    const result = picker.pick();
    await fake.flush();
    fake.emit('Overlay.inspectNodeRequested', { backendNodeId: 5 });
    expect(await result).toEqual({ ok: false, reason: 'not-available' });
    fake.detach();
    expect(await picker.pick()).toEqual({ ok: false, reason: 'not-available' });
    expect(await picker.candidates()).toEqual({ ok: false, reason: 'not-available' });
  });

  it('finds by path and highlights with the overlay for a while, then turns the domains off', async () => {
    const fake = fakeContents();
    const picker = new ElementPicker(fake.contents, { pickTimeoutMs: 1000, commandTimeoutMs: 100, highlightMs: 20 });
    expect(await picker.describePath([1, 0])).toEqual({ ok: true, value: { tag: 'button' } });
    expect(await picker.highlight([1, 0])).toEqual({ ok: true, value: null });
    expect(fake.commands.find((c) => c.method === 'Overlay.highlightNode')?.params).toMatchObject({
      objectId: 'obj-2',
    });
    await new Promise((r) => setTimeout(r, 60));
    expect(methods(fake.commands).slice(-3)).toEqual(['Overlay.hideHighlight', 'Overlay.disable', 'DOM.disable']);
  });

  it('a failed DOM.enable counts nothing: the next pick enables the domains again (review fix)', async () => {
    let failEnable = true;
    const fake = fakeContents({
      'DOM.enable': () => {
        if (failEnable) throw new Error('busy page');
        return {};
      },
    });
    const picker = new ElementPicker(fake.contents);
    expect(await picker.highlight([1])).toEqual({ ok: false, reason: 'not-available' });
    failEnable = false;
    const result = picker.pick();
    await fake.flush();
    await fake.flush();
    expect(methods(fake.commands).filter((m) => m === 'DOM.enable')).toHaveLength(2);
    expect(picker.isInspecting).toBe(true);
    picker.cancel();
    expect(await result).toEqual({ ok: false, reason: 'cancelled' });
  });

  it('a path to nothing is not available', async () => {
    const fake = fakeContents({ 'Runtime.evaluate': () => ({ result: { subtype: 'null', value: null } }) });
    const picker = new ElementPicker(fake.contents);
    expect(await picker.describePath([9, 9])).toEqual({ ok: false, reason: 'not-available' });
  });
});

describe('element-target scripts and parsers (S41.3)', () => {
  it('every script is valid JavaScript with only literal inputs', () => {
    expect(() => new Script(`(${describeFunction()})`)).not.toThrow();
    expect(() => new Script(candidatesExpression())).not.toThrow();
    expect(() => new Script(elementAtPathExpression([1, 2]))).not.toThrow();
    expect(() => new Script(elementInRegionExpression({ x: 0.1, y: 0.2, width: 0.3, height: 0.4 }))).not.toThrow();
    // Bad path entries never reach the script text.
    expect(elementAtPathExpression([1, -1, 2.5, Number.NaN, 3])).toContain('[1,3]');
  });

  it('parseTarget validates, caps and turns same-origin style sheets into project paths', () => {
    const target = parseTarget(
      {
        tag: 'button',
        id: 'send',
        classes: ['cta', 42, 'x'.repeat(200)],
        text: '  发送\n\n ',
        selector: '#send',
        path: [1, 0, 2],
        ancestry: [
          { tag: 'main', nth: 1 },
          { tag: 'BAD TAG', nth: 1 },
          { tag: 'button', nth: 0 },
        ],
        rect: { x: 1, y: 2, width: 30, height: Number.POSITIVE_INFINITY },
        viewport: { width: 800, height: 600 },
        rules: [
          { href: 'http://127.0.0.1:5000/%E6%A0%B7%E5%BC%8F%20%E8%A1%A8.css', selector: '.cta', occurrence: 2 },
          { href: 'https://cdn.example.com/x.css', selector: '.cta', occurrence: 1 },
          { styleIndex: 0, selector: '#send', occurrence: 1 },
          { styleIndex: -1, selector: 'p' },
        ],
      },
      { origin: 'http://127.0.0.1:5000', pagePath: '首 页.html', kind: 'element' },
    );
    expect(target).toMatchObject({
      kind: 'element',
      pagePath: '首 页.html',
      tag: 'button',
      id: 'send',
      text: '发送',
      path: [1, 0, 2],
      // One unusable step (an invalid tag, nth 0) drops the whole ancestry: a shorter chain could mislead.
      ancestry: [],
      rect: { x: 1, y: 2, width: 30, height: 0 },
      rules: [
        { sheet: { kind: 'file', path: '样式 表.css' }, selector: '.cta', occurrence: 2 },
        { sheet: { kind: 'style', index: 0 }, selector: '#send', occurrence: 1 },
      ],
    });
    expect(target?.classes).toHaveLength(2);
    const valid = parseTarget(
      {
        tag: 'p',
        path: [0],
        ancestry: [
          { tag: 'main', nth: 1 },
          { tag: 'p', nth: 2 },
        ],
      },
      { origin: 'http://x', pagePath: '', kind: 'element' },
    );
    expect(valid?.ancestry).toEqual([
      { tag: 'main', nth: 1 },
      { tag: 'p', nth: 2 },
    ]);
    expect(target?.classes[1]).toHaveLength(80);
    expect(
      parseTarget({ tag: 'button', path: null }, { origin: 'http://x', pagePath: '', kind: 'element' }),
    ).toBeNull();
    expect(parseTarget({ tag: '<img>', path: [] }, { origin: 'http://x', pagePath: '', kind: 'element' })).toBeNull();
  });

  it('parseCandidates keeps valid entries only', () => {
    expect(
      parseCandidates({ items: [{ path: [0], label: 'h1 "你好"' }, { path: [-1], label: 'x' }, { path: [1] }] }),
    ).toEqual({ items: [{ path: [0], label: 'h1 "你好"' }], truncated: false });
    expect(parseCandidates('nope')).toBeNull();
  });

  it('clampRegion keeps a region inside the viewport and refuses an empty one', () => {
    expect(clampRegion({ x: -0.1, y: 0.5, width: 0.5, height: 0.9 })).toEqual({ x: 0, y: 0.5, width: 0.5, height: 0.5 }); // prettier-ignore
    expect(clampRegion({ x: 0.5, y: 0.5, width: 0, height: 0.2 })).toBeNull();
  });
});
