import { defineConfig } from 'vite';

// Preload bundle for the trusted workbench only. User webpages never get a preload (AGENTS.md invariant).
export default defineConfig({});
