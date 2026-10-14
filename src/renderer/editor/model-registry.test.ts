import { describe, expect, it } from 'vitest';
import { ModelRegistry, type ModelHost, type ModelSpec } from './model-registry';

class FakeModel {
  disposed = false;
  undo: string[] = [];
  constructor(
    readonly uri: string,
    public text: string,
  ) {}
  dispose() {
    this.disposed = true;
  }
  isDisposed() {
    return this.disposed;
  }
}

function setup() {
  const created: FakeModel[] = [];
  const external = new Map<string, FakeModel>();
  const host: ModelHost<FakeModel> = {
    find: (uri) => external.get(uri) ?? null,
    create: (spec: ModelSpec) => {
      const model = new FakeModel(spec.uri, spec.text);
      created.push(model);
      return model;
    },
  };
  return { registry: new ModelRegistry<FakeModel, { line: number }>(host), created, external };
}

const index = { uri: 'file:///D:/%E4%B8%AD%E6%96%87/index.html', text: '<p>你好</p>', language: 'html' };
const style = { uri: 'file:///D:/%E4%B8%AD%E6%96%87/style.css', text: 'p{}', language: 'css' };

describe('editor model registry (S09.1)', () => {
  it('creates one model per URI and reuses it on every later switch', () => {
    const { registry, created } = setup();
    const first = registry.acquire(index);
    registry.acquire(style);
    first.text = 'edited';
    first.undo.push('typed');
    const again = registry.acquire({ ...index, text: 'stale text from disk' });
    expect(again).toBe(first);
    expect(again.text).toBe('edited');
    expect(again.undo).toEqual(['typed']);
    expect(created).toHaveLength(2);
    expect(registry.uris()).toEqual([index.uri, style.uri]);
  });

  it('keeps view state (cursor, scroll, folding) per URI until the file is closed', () => {
    const { registry } = setup();
    registry.acquire(index);
    registry.acquire(style);
    registry.saveViewState(index.uri, { line: 12 });
    registry.saveViewState(style.uri, { line: 3 });
    expect(registry.viewState(index.uri)).toEqual({ line: 12 });
    expect(registry.viewState(style.uri)).toEqual({ line: 3 });
    registry.saveViewState(index.uri, null);
    expect(registry.viewState(index.uri)).toBeUndefined();
  });

  it('ignores view state for a URI it does not hold', () => {
    const { registry } = setup();
    registry.saveViewState(index.uri, { line: 1 });
    expect(registry.viewState(index.uri)).toBeUndefined();
  });

  it('disposes the model and forgets view state when a file is closed; reopening starts fresh', () => {
    const { registry, created } = setup();
    const model = registry.acquire(index);
    registry.saveViewState(index.uri, { line: 4 });
    registry.release(index.uri);
    expect(model.disposed).toBe(true);
    expect(registry.has(index.uri)).toBe(false);
    expect(registry.viewState(index.uri)).toBeUndefined();
    const reopened = registry.acquire(index);
    expect(reopened).not.toBe(model);
    expect(reopened.text).toBe(index.text);
    expect(created).toHaveLength(2);
  });

  it('adopts a model that Monaco already holds instead of creating a duplicate', () => {
    const { registry, created, external } = setup();
    const existing = new FakeModel(index.uri, 'already there');
    external.set(index.uri, existing);
    expect(registry.acquire(index)).toBe(existing);
    expect(created).toHaveLength(0);
  });

  it('replaces a model that was disposed behind its back', () => {
    const { registry } = setup();
    const model = registry.acquire(index);
    model.dispose();
    expect(registry.has(index.uri)).toBe(false);
    expect(registry.acquire(index)).not.toBe(model);
  });

  it('lets the host discard a released model (Monaco: clear its undo stack before disposal)', () => {
    const discarded: string[] = [];
    const registry = new ModelRegistry<FakeModel>({
      find: () => null,
      create: (spec) => new FakeModel(spec.uri, spec.text),
      discard: (model) => {
        discarded.push(model.text);
        model.text = '';
        model.dispose();
      },
    });
    const model = registry.acquire(index);
    registry.release(index.uri);
    expect(discarded).toEqual([index.text]);
    expect(model.disposed).toBe(true);
  });

  it('retainOnly releases closed files and keeps open ones', () => {
    const { registry } = setup();
    const a = registry.acquire(index);
    const b = registry.acquire(style);
    expect(registry.retainOnly([style.uri])).toEqual([index.uri]);
    expect(a.disposed).toBe(true);
    expect(b.disposed).toBe(false);
  });
});
