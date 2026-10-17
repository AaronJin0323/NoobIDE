import { describe, expect, it } from 'vitest';
import {
  installFormatHook,
  onBeforeFormat,
  onFormatOutcome,
  type FormatOutcomeEvent,
  type FormattingRegistry,
  type PreFormatEvent,
} from './format-hook';

class Provider {
  displayName = 'css';
  calls = 0;
  provideDocumentFormattingEdits(_model?: unknown) {
    this.calls += 1;
    return ['edit'];
  }
  provideDocumentRangeFormattingEdits(_model?: unknown) {
    this.calls += 1;
    return ['range-edit'];
  }
}

const model = (text: string) => ({
  uri: { toString: () => 'file:///p/a.css' },
  getValue: () => text,
  getLanguageId: () => 'css',
});

function fakeRegistry() {
  const registered: { kind: string; provider: Record<string, unknown> }[] = [];
  const registry: FormattingRegistry<string> = {
    registerDocumentFormattingEditProvider: (_s, provider) =>
      registered.push({ kind: 'document', provider: provider as never }),
    registerDocumentRangeFormattingEditProvider: (_s, provider) =>
      registered.push({ kind: 'range', provider: provider as never }),
  };
  return { registry, registered };
}

describe('pre-format hook (S18.3)', () => {
  it('emits the text before the real provider formats, for document and range formatting', () => {
    const { registry, registered } = fakeRegistry();
    installFormatHook(registry);
    installFormatHook(registry); // idempotent: wrapping twice would emit twice
    const provider = new Provider();
    registry.registerDocumentFormattingEditProvider('css', provider);
    registry.registerDocumentRangeFormattingEditProvider('css', provider);

    const events: PreFormatEvent[] = [];
    const order: string[] = [];
    const off = onBeforeFormat((e) => {
      events.push(e);
      order.push(`hook@${provider.calls}`);
    });
    const doc = registered[0]?.provider as unknown as Provider;
    const range = registered[1]?.provider as unknown as Provider;
    expect(doc.provideDocumentFormattingEdits.call(doc, model('a{color:red}') as never)).toEqual(['edit']);
    expect(range.provideDocumentRangeFormattingEdits.call(range, model('b{}') as never)).toEqual(['range-edit']);
    off();
    expect(events).toEqual([
      { uri: 'file:///p/a.css', text: 'a{color:red}', languageId: 'css' },
      { uri: 'file:///p/a.css', text: 'b{}', languageId: 'css' },
    ]);
    expect(order).toEqual(['hook@0', 'hook@1']); // the hook ran before each provider call
    expect(doc.displayName).toBe('css'); // other members survive the wrapping
  });

  it('a failing subscriber never blocks formatting', () => {
    const { registry, registered } = fakeRegistry();
    installFormatHook(registry);
    const provider = new Provider();
    registry.registerDocumentFormattingEditProvider('css', provider);
    const off = onBeforeFormat(() => {
      throw new Error('history is down');
    });
    const doc = registered[0]?.provider as unknown as Provider;
    expect(doc.provideDocumentFormattingEdits.call(doc, model('x') as never)).toEqual(['edit']);
    off();
  });

  it('reports how document formatting ended: edits or none are fine, a rejection or a throw fail (S53.4)', async () => {
    const { registry, registered } = fakeRegistry();
    installFormatHook(registry);
    const answers: unknown[] = [Promise.resolve(['edit']), Promise.resolve(null), Promise.reject(new Error('x'))];
    registry.registerDocumentFormattingEditProvider('css', {
      provideDocumentFormattingEdits: () => {
        if (answers.length === 0) throw new Error('worker gone');
        return answers.shift();
      },
    });
    const outcomes: FormatOutcomeEvent[] = [];
    const off = onFormatOutcome((e) => outcomes.push(e));
    const doc = registered[0]?.provider as unknown as { provideDocumentFormattingEdits(m: unknown): unknown };
    for (let i = 0; i < 3; i += 1)
      await Promise.resolve(doc.provideDocumentFormattingEdits(model('a{}'))).catch(() => 0);
    expect(() => doc.provideDocumentFormattingEdits(model('a{}'))).toThrow('worker gone');
    await new Promise((resolve) => setTimeout(resolve, 0));
    off();
    expect(outcomes.map((o) => o.ok)).toEqual([true, true, false, false]);
    expect(outcomes[0]?.uri).toBe('file:///p/a.css');
  });
});
