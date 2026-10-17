import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  editorPrefs,
  loadEditorPrefs,
  resetEditorPrefsForTests,
  setEditorPrefs,
  type PrefsBackend,
} from './editor-prefs';

afterEach(() => resetEditorPrefsForTests());

function backend(stored: Partial<ReturnType<typeof editorPrefs>>) {
  const update = vi.fn(async () => undefined);
  const api: PrefsBackend = {
    get: async () => ({ ok: true, value: { settings: { ...editorPrefs(), ...stored } } }),
    update,
  };
  return { api, update };
}

describe('editor prefs (S53)', () => {
  it('defaults: Emmet on, hint not shown, format on save off', () => {
    expect(editorPrefs()).toEqual({ emmet: true, emmetHintShown: false, formatOnSave: false });
  });

  it('loads the stored switches', async () => {
    await loadEditorPrefs(backend({ emmet: false, formatOnSave: true }).api);
    expect(editorPrefs()).toEqual({ emmet: false, emmetHintShown: false, formatOnSave: true });
  });

  it('a change persists and is not overwritten by a load that arrives later', async () => {
    const { api, update } = backend({ emmet: true, emmetHintShown: false });
    const loading = loadEditorPrefs(api);
    setEditorPrefs({ emmet: false });
    await loading;
    expect(editorPrefs().emmet).toBe(false);
    expect(update).toHaveBeenCalledWith({ emmet: false });
  });
});
