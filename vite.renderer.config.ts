import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const root = path.dirname(fileURLToPath(import.meta.url));

// Workbench renderer (React + Monaco). Everything is bundled locally; no CDN (offline-first invariant).
export default defineConfig({
  root: path.join(root, 'src/renderer'),
  plugins: [react()],
  build: {
    // Forge loads the build from .vite/renderer/<name>; keep that location even though root is src/renderer.
    outDir: path.join(root, '.vite/renderer/main_window'),
    emptyOutDir: true,
    // Monaco is large by nature; it is loaded locally, so the size warning is noise.
    chunkSizeWarningLimit: 8000,
  },
  worker: {
    format: 'es',
  },
});
