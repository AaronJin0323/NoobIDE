/// <reference types="vite/client" />

interface Window {
  /** Placeholder bridge from src/preload/preload.ts; replaced by the typed API in S03.1. */
  readonly noobide?: { readonly apiVersion: number };
}
