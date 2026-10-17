/**
 * The one-time Emmet hint (S53.1): raised by the first expansion ever (emmet-monaco.ts), shown in the editor's status
 * bar (EmmetHint.tsx) until dismissed. Monaco-free, so the status bar does not load the editor chunk.
 */
import { useSyncExternalStore } from 'react';

let visible = false;
const listeners = new Set<() => void>();
const emit = () => {
  for (const listener of listeners) listener();
};

export const emmetHintVisible = () => visible;

export function showEmmetHint(): void {
  visible = true;
  emit();
}

export function dismissEmmetHint(): void {
  visible = false;
  emit();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useEmmetHint(): boolean {
  return useSyncExternalStore(subscribe, emmetHintVisible);
}
