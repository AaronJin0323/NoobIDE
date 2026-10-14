/// <reference types="vite/client" />
import type { NoobideApi } from '../shared/ipc/contract';

declare global {
  /** S28.1: package.json "version", inlined at build time by vite.renderer.config.ts (shown in the About dialog). */
  const __NOOBIDE_VERSION__: string;

  interface Window {
    /** Typed bridge from src/preload/preload.ts (S03.1). Absent only if the preload failed to load. */
    readonly noobide?: NoobideApi;
  }
}

export {};
