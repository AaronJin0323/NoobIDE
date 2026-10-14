import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const root = path.dirname(fileURLToPath(import.meta.url));
// S28.1: the About dialog shows the same version Electron reports (app.getVersion() reads package.json too).
const { version } = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as { version: string };

// Workbench renderer (React + Monaco). Everything is bundled locally; no CDN (offline-first invariant).
export default defineConfig({
  root: path.join(root, 'src/renderer'),
  plugins: [react()],
  define: { __NOOBIDE_VERSION__: JSON.stringify(version) },
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
