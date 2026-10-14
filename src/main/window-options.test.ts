import { describe, expect, it } from 'vitest';
import {
  createWorkbenchWebPreferences,
  createWorkbenchWindowOptions,
  insecurePreferences,
  REQUIRED_WORKBENCH_PREFERENCES,
} from './window-options';

describe('workbench webPreferences factory (S02.2)', () => {
  const prefs = createWorkbenchWebPreferences('/app/.vite/build/preload.cjs');

  it('isolates the renderer: context isolation, no Node, OS sandbox, web security', () => {
    expect(prefs.contextIsolation).toBe(true);
    expect(prefs.nodeIntegration).toBe(false);
    expect(prefs.sandbox).toBe(true);
    expect(prefs.webSecurity).toBe(true);
  });

  it('closes the other Node and content escape hatches', () => {
    expect(prefs.nodeIntegrationInWorker).toBe(false);
    expect(prefs.nodeIntegrationInSubFrames).toBe(false);
    expect(prefs.allowRunningInsecureContent).toBe(false);
    expect(prefs.experimentalFeatures).toBe(false);
    expect(prefs.webviewTag).toBe(false);
    expect(prefs.navigateOnDragDrop).toBe(false);
  });

  it('uses the given preload and nothing else that loads code', () => {
    expect(prefs.preload).toBe('/app/.vite/build/preload.cjs');
    expect(Object.keys(prefs).sort()).toMatchInlineSnapshot(`
      [
        "allowRunningInsecureContent",
        "contextIsolation",
        "experimentalFeatures",
        "navigateOnDragDrop",
        "nodeIntegration",
        "nodeIntegrationInSubFrames",
        "nodeIntegrationInWorker",
        "preload",
        "safeDialogs",
        "sandbox",
        "spellcheck",
        "webSecurity",
        "webviewTag",
      ]
    `);
  });

  it('passes its own startup assertion, and the assertion catches any weakened value', () => {
    expect(insecurePreferences(prefs)).toEqual([]);
    for (const key of Object.keys(REQUIRED_WORKBENCH_PREFERENCES)) {
      const weakened = { ...prefs, [key]: !(prefs as Record<string, unknown>)[key] };
      expect(insecurePreferences(weakened)).toEqual([key]);
    }
    expect(insecurePreferences({})).toHaveLength(Object.keys(REQUIRED_WORKBENCH_PREFERENCES).length);
  });

  it('window is titled NoobIDE and starts hidden until ready-to-show', () => {
    const options = createWorkbenchWindowOptions('/p.cjs');
    expect(options.title).toBe('NoobIDE');
    expect(options.show).toBe(false);
    expect(options.webPreferences).toEqual(createWorkbenchWebPreferences('/p.cjs'));
  });
});
