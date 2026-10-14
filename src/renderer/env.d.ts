/// <reference types="vite/client" />
import type { NoobideApi } from '../shared/ipc/contract';

declare global {
  interface Window {
    /** Typed bridge from src/preload/preload.ts (S03.1). Absent only if the preload failed to load. */
    readonly noobide?: NoobideApi;
  }
}

export {};
