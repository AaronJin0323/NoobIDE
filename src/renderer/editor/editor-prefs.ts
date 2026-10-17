/**
 * The editor switches of the app settings (S53): Emmet on Tab, its one-time hint, format on save. A small store the
 * Monaco glue (no React) and the workbench (React) both read. The persisted settings are the source of truth; a
 * change made before they arrive wins over them, like the theme choice (ThemeProvider).
 */
import { useSyncExternalStore } from 'react';
import { DEFAULT_SETTINGS, type AppSettings } from '../../shared/settings';

export type EditorPrefs = Pick<AppSettings, 'emmet' | 'emmetHintShown' | 'formatOnSave'>;

export interface PrefsBackend {
  get(): Promise<{ ok: true; value: { settings: EditorPrefs } } | { ok: false }>;
  update(patch: Partial<EditorPrefs>): Promise<unknown>;
}

let prefs: EditorPrefs = {
  emmet: DEFAULT_SETTINGS.emmet,
  emmetHintShown: DEFAULT_SETTINGS.emmetHintShown,
  formatOnSave: DEFAULT_SETTINGS.formatOnSave,
};
const changed = new Set<keyof EditorPrefs>();
const listeners = new Set<() => void>();
let backend: PrefsBackend | null = null;

const emit = () => {
  for (const listener of listeners) listener();
};

/** Loads the stored values once (main window start). Fields changed meanwhile keep the newer value. */
export async function loadEditorPrefs(from: PrefsBackend | null | undefined): Promise<void> {
  backend = from ?? null;
  if (!backend) return;
  const result = await backend.get().catch(() => null);
  if (!result?.ok) return;
  const stored = result.value.settings;
  const next = { ...prefs };
  for (const key of Object.keys(next) as (keyof EditorPrefs)[]) {
    if (!changed.has(key) && typeof stored[key] === 'boolean') next[key] = stored[key];
  }
  prefs = next;
  emit();
}

export function editorPrefs(): EditorPrefs {
  return prefs;
}

/** Changes switches now (the editor reads them on the next key press) and persists them. */
export function setEditorPrefs(patch: Partial<EditorPrefs>): void {
  for (const key of Object.keys(patch) as (keyof EditorPrefs)[]) changed.add(key);
  prefs = { ...prefs, ...patch };
  emit();
  void backend?.update(patch).catch(() => undefined);
}

export function subscribeEditorPrefs(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useEditorPrefs(): EditorPrefs {
  return useSyncExternalStore(subscribeEditorPrefs, editorPrefs);
}

/** Tests only: back to the defaults, no backend. */
export function resetEditorPrefsForTests(): void {
  prefs = {
    emmet: DEFAULT_SETTINGS.emmet,
    emmetHintShown: DEFAULT_SETTINGS.emmetHintShown,
    formatOnSave: DEFAULT_SETTINGS.formatOnSave,
  };
  changed.clear();
  backend = null;
}
