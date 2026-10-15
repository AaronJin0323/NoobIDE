import { afterEach, describe, expect, it } from 'vitest';
import {
  convertIndentation,
  indentOverride,
  publishIndent,
  registerIndentCommands,
  resetIndentState,
  setIndentOverride,
  shownIndent,
  subscribeIndent,
} from './indent-state';

const detected = { insertSpaces: true, tabSize: 4, source: 'detected', mixed: false } as const;

afterEach(() => resetIndentState());

describe('indent state for the status bar (S43.2)', () => {
  it('publishes the shown file and notifies only on a real change', () => {
    let calls = 0;
    subscribeIndent(() => (calls += 1));
    publishIndent({ uri: 'file:///a.js', indent: detected });
    publishIndent({ uri: 'file:///a.js', indent: { ...detected } });
    expect(calls).toBe(1);
    publishIndent({ uri: 'file:///a.js', indent: { ...detected, source: 'override' } });
    expect(calls).toBe(2);
    publishIndent(null);
    expect(shownIndent()).toBeNull();
    expect(calls).toBe(3);
  });

  it('an override is kept per file and re-applied through the editor commands', () => {
    const reapplied: string[] = [];
    const converted: string[] = [];
    registerIndentCommands({ reapply: (uri) => reapplied.push(uri), convert: (uri) => converted.push(uri) });
    setIndentOverride('file:///a.js', { insertSpaces: false, tabSize: 4 });
    expect(indentOverride('file:///a.js')).toEqual({ insertSpaces: false, tabSize: 4 });
    expect(indentOverride('file:///b.js')).toBeNull();
    setIndentOverride('file:///a.js', null); // "Detect again"
    expect(indentOverride('file:///a.js')).toBeNull();
    convertIndentation('file:///a.js');
    expect(reapplied).toEqual(['file:///a.js', 'file:///a.js']);
    expect(converted).toEqual(['file:///a.js']);
  });

  it('without an editor the commands do nothing', () => {
    expect(() => convertIndentation('file:///a.js')).not.toThrow();
    setIndentOverride('file:///a.js', { insertSpaces: true, tabSize: 2 });
    expect(indentOverride('file:///a.js')).toEqual({ insertSpaces: true, tabSize: 2 });
  });
});
