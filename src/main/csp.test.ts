import { describe, expect, it } from 'vitest';
import { buildCsp } from './csp';

function parse(csp: string): Map<string, string[]> {
  return new Map(
    csp.split(';').map((d) => {
      const [name = '', ...values] = d.trim().split(/\s+/);
      return [name, values];
    }),
  );
}

describe('workbench Content-Security-Policy (S02.2)', () => {
  const prod = parse(buildCsp('production'));

  it('denies by default and allows scripts only from the app itself', () => {
    expect(prod.get('default-src')).toEqual(["'none'"]);
    expect(prod.get('script-src')).toEqual(["'self'"]);
    expect(prod.get('worker-src')).toEqual(["'self'"]);
    expect(prod.get('connect-src')).toEqual(["'self'"]);
  });

  it('never allows eval, inline scripts or remote origins in production', () => {
    const all = buildCsp('production');
    expect(all).not.toContain('unsafe-eval');
    expect(prod.get('script-src')).not.toContain("'unsafe-inline'");
    expect(all).not.toMatch(/https?:|wss?:|\*/);
  });

  it('blocks plugins, framing, base hijacking and form posts', () => {
    expect(prod.get('object-src')).toEqual(["'none'"]);
    expect(prod.get('frame-src')).toEqual(["'none'"]);
    expect(prod.get('frame-ancestors')).toEqual(["'none'"]);
    expect(prod.get('base-uri')).toEqual(["'none'"]);
    expect(prod.get('form-action')).toEqual(["'none'"]);
  });

  it('development adds only the Vite dev server needs, still no eval', () => {
    const dev = parse(buildCsp('development', 'http://localhost:5173'));
    expect(dev.get('connect-src')).toEqual(["'self'", 'ws://localhost:5173']);
    expect(dev.get('script-src')).toEqual(["'self'", "'unsafe-inline'"]);
    expect(buildCsp('development', 'http://localhost:5173')).not.toContain('unsafe-eval');
    expect(() => buildCsp('development')).toThrow();
  });
});
