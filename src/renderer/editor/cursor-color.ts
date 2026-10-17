/**
 * The colour value at the cursor of the code editor (S53.3), published by the editor glue (authoring-monaco.ts) and
 * shown by the status bar (ColorStatus.tsx) with its value as text. Monaco-free, so the status bar does not load the
 * editor chunk. `pickerOpen` asks the workbench to show the colour picker.
 */
import { useSyncExternalStore } from 'react';
import type { ColorFormat, Rgba } from './css-colors';

export interface CursorColor {
  readonly text: string;
  readonly format: ColorFormat;
  readonly rgba: Rgba;
}

let current: CursorColor | null = null;
let pickerOpen = false;
const listeners = new Set<() => void>();
const emit = () => {
  for (const listener of listeners) listener();
};
function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export const cursorColor = () => current;

export function publishCursorColor(next: CursorColor | null): void {
  if (current?.text === next?.text && current?.format === next?.format) return;
  current = next;
  emit();
}

export function useCursorColor(): CursorColor | null {
  return useSyncExternalStore(subscribe, cursorColor);
}

export const colorPickerOpen = () => pickerOpen;

export function openColorPicker(): void {
  pickerOpen = true;
  emit();
}

export function closeColorPicker(): void {
  pickerOpen = false;
  emit();
}

export function useColorPickerOpen(): boolean {
  return useSyncExternalStore(subscribe, colorPickerOpen);
}
