import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { IME_GRACE_MS, createImeGuard, installImeGuard, isImeKey } from './ime';

describe('IME keyboard ownership', () => {
  it('protects composition and its boundary key even when isComposing is false', () => {
    expect(isImeKey({ isComposing: true, keyCode: 13 })).toBe(true);
    expect(isImeKey({ isComposing: false, keyCode: 229 })).toBe(true);
  });
  it('leaves ordinary Enter, Escape and shortcuts available', () => {
    for (const keyCode of [13, 27, 73]) expect(isImeKey({ isComposing: false, keyCode })).toBe(false);
  });
});

/** A guard on a fake clock; `webkit` says whether the engine reports navigator.vendor "Apple…". */
function guardAt(webkit: boolean) {
  let t = 10_000;
  const guard = createImeGuard({ now: () => t, webkit: () => webkit });
  return { guard, advance: (ms: number) => (t += ms) };
}

const enter = { key: 'Enter', keyCode: 13, isComposing: false };
const escape = { key: 'Escape', keyCode: 27, isComposing: false };

describe('IME guard stage 2 (S48.3)', () => {
  it('on WebKit, ignores an Enter within 500 ms of compositionend', () => {
    const { guard, advance } = guardAt(true);
    expect(guard.isImeKey(enter)).toBe(false); // no composition yet
    guard.compositionEnded();
    expect(guard.isImeKey(enter)).toBe(true);
    advance(IME_GRACE_MS);
    expect(guard.isImeKey(enter)).toBe(true);
    advance(1);
    expect(guard.isImeKey(enter)).toBe(false);
  });

  it('lets Ctrl+Enter and Cmd+Enter through right after the composition', () => {
    const { guard } = guardAt(true);
    guard.compositionEnded();
    expect(guard.isImeKey({ ...enter, ctrlKey: true })).toBe(false);
    expect(guard.isImeKey({ ...enter, metaKey: true })).toBe(false);
    // Composing still wins over a modifier.
    expect(guard.isImeKey({ ...enter, metaKey: true, isComposing: true })).toBe(true);
  });

  it('treats an Escape right after compositionend on WebKit as the IME closing its candidates', () => {
    const { guard, advance } = guardAt(true);
    guard.compositionEnded();
    expect(guard.isImeKey(escape)).toBe(true);
    expect(guard.isImeKey({ ...escape, ctrlKey: true })).toBe(true);
    advance(IME_GRACE_MS + 1);
    expect(guard.isImeKey(escape)).toBe(false);
  });

  it('changes nothing elsewhere: other engines, and other keys on WebKit', () => {
    const chromium = guardAt(false);
    chromium.guard.compositionEnded();
    expect(chromium.guard.isImeKey(enter)).toBe(false);
    expect(chromium.guard.isImeKey(escape)).toBe(false);
    const webkit = guardAt(true);
    webkit.guard.compositionEnded();
    for (const key of ['a', 'ArrowDown', 'Tab', ' ']) expect(webkit.guard.isImeKey({ key, keyCode: 65 })).toBe(false);
  });

  it('records compositionend and stops an IME Escape before later window listeners', () => {
    const { guard } = guardAt(true);
    const target = new EventTarget();
    const uninstall = installImeGuard(target, guard);
    const reached: string[] = [];
    target.addEventListener('keydown', (event) => reached.push((event as Event & { key: string }).key), true);
    const key = (init: Record<string, unknown>) => Object.assign(new Event('keydown', { cancelable: true }), init);

    // An Escape that cancels a composition (stage 1) never reaches the dialog's listener, and is not cancelled.
    const cancelling = key({ key: 'Escape', isComposing: true });
    target.dispatchEvent(cancelling);
    expect(reached).toEqual([]);
    expect(cancelling.defaultPrevented).toBe(false);
    // A WebKit Escape right after compositionend (stage 2) is stopped too.
    target.dispatchEvent(new Event('compositionend'));
    target.dispatchEvent(key(escape));
    expect(reached).toEqual([]);
    // Enter is left to each field's own check (Ctrl/Cmd+Enter may be a shortcut); ordinary Escape passes later.
    target.dispatchEvent(key(enter));
    expect(reached).toEqual(['Enter']);
    uninstall();
    target.dispatchEvent(new Event('compositionend'));
    target.dispatchEvent(key(escape));
    expect(reached).toEqual(['Enter', 'Escape']);
  });

  it('is the one guard: every IME-aware field asks isImeKey from workbench/ime, none checks composition itself', () => {
    const fields = {
      chat: '../ai/ChatPanel.tsx',
      'inline edit': '../ai/InlineEditPanel.tsx',
      rename: './NameEditor.tsx',
      wizard: '../welcome/CreateProjectDialog.tsx',
      palette: '../commands/CommandPalette.tsx',
      'annotation notes': '../annotations/AnnotationsStrip.tsx',
      dialogs: './focus-trap.ts',
    };
    for (const [what, file] of Object.entries(fields)) {
      const source = readFileSync(new URL(file, import.meta.url), 'utf8');
      expect(source, what).toMatch(/import \{ isImeKey \} from '(\.\.\/workbench|\.)\/ime';/);
      expect(source, what).toMatch(/isImeKey\(/);
      expect(source, what).not.toMatch(/isComposing|keyCode === 229|compositionend/);
    }
    // Installed once, at startup, before the workbench mounts.
    const main = readFileSync(new URL('../main.tsx', import.meta.url), 'utf8');
    expect(main.indexOf('installImeGuard(window)')).toBeGreaterThan(-1);
    expect(main.indexOf('installImeGuard(window)')).toBeLessThan(main.indexOf('createRoot('));
  });
});
