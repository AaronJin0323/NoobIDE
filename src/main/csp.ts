/**
 * Content-Security-Policy for the workbench renderer (S02.2). Delivered as an HTTP response header by the
 * noobide:// protocol handler (production) and by a header rewrite for the Vite dev server (development).
 *
 * - No remote origins at all: the workbench is offline-first and never loads CDN assets.
 * - No 'unsafe-eval' and no inline scripts in production.
 * - style-src needs 'unsafe-inline' because Monaco creates <style> elements at runtime.
 * - Development adds only what Vite's dev server needs (inline React-refresh preamble, HMR websocket).
 */
export type CspMode = 'production' | 'development';

export function buildCsp(mode: CspMode, devServerOrigin?: string): string {
  const dev = mode === 'development';
  if (dev && !devServerOrigin) throw new Error('development CSP needs the dev server origin');
  const ws = dev && devServerOrigin ? devServerOrigin.replace(/^http/, 'ws') : '';
  const directives: Record<string, string[]> = {
    'default-src': ["'none'"],
    'script-src': dev ? ["'self'", "'unsafe-inline'"] : ["'self'"],
    'style-src': ["'self'", "'unsafe-inline'"],
    'img-src': ["'self'", 'data:'],
    'font-src': ["'self'", 'data:'],
    'worker-src': ["'self'"],
    'connect-src': dev ? ["'self'", ws] : ["'self'"],
    'object-src': ["'none'"],
    'base-uri': ["'none'"],
    'form-action': ["'none'"],
    'frame-src': ["'none'"],
    'frame-ancestors': ["'none'"],
  };
  return Object.entries(directives)
    .map(([name, values]) => `${name} ${values.join(' ')}`)
    .join('; ');
}
