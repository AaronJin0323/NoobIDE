import { describe, expect, it } from 'vitest';
import {
  CSS_LINT,
  JS_COMPILER_OPTIONS,
  JS_DIAGNOSTICS_OPTIONS,
  KEPT_TS_CODES,
  NOISY_TS_CODES,
  configureLanguages,
  type LanguageDefaults,
} from './language-config';

function fakeDefaults() {
  const calls: string[] = [];
  const seen: Record<string, unknown> = {};
  const defaults: LanguageDefaults = {
    javascript: {
      setCompilerOptions: (o) => {
        calls.push('js.compiler');
        seen.compiler = o;
      },
      setDiagnosticsOptions: (o) => {
        calls.push('js.diagnostics');
        seen.diagnostics = o;
      },
      setEagerModelSync: (v) => {
        calls.push('js.eager');
        seen.eager = v;
      },
      modeConfiguration: { hovers: true, definitions: true },
      setModeConfiguration: (c) => {
        calls.push('js.mode');
        seen.mode = c;
      },
    },
    css: {
      setOptions: (o) => {
        calls.push('css');
        seen.css = o;
      },
    },
    html: {
      options: { format: { tabSize: 4, endWithNewline: false } },
      setOptions: (o) => {
        calls.push('html');
        seen.html = o;
      },
    },
  };
  return { defaults, calls, seen };
}

describe('language configuration (S18.1)', () => {
  it('configures JavaScript and CSS services', () => {
    const { defaults, calls, seen } = fakeDefaults();
    configureLanguages(defaults);
    expect(calls).toEqual(['js.compiler', 'js.diagnostics', 'js.eager', 'js.mode', 'css', 'html']);
    // S57: Monaco's own definition / references / rename are off; everything else is kept.
    expect(seen.mode).toEqual({ hovers: true, definitions: false, references: false, rename: false });
    expect(seen.compiler).toEqual(JS_COMPILER_OPTIONS);
    expect(seen.diagnostics).toEqual(JS_DIAGNOSTICS_OPTIONS);
    expect(seen.eager).toBe(true);
    expect(seen.css).toEqual({ validate: true, lint: CSS_LINT });
    // S18.3: the HTML formatter keeps the final line break; its other settings are kept.
    expect(seen.html).toEqual({ format: { tabSize: 4, endWithNewline: true } });
  });

  it('checks plain JavaScript so undefined names are found, without strict typing', () => {
    expect(JS_COMPILER_OPTIONS).toMatchObject({ allowJs: true, checkJs: true, strict: false, noImplicitAny: false });
    expect(JS_DIAGNOSTICS_OPTIONS.noSyntaxValidation).toBe(false);
    expect(JS_DIAGNOSTICS_OPTIONS.noSemanticValidation).toBe(false);
  });
});

describe('beginner-tuned diagnostics (S19.2)', () => {
  it('never ignores an undefined-name, redeclaration or syntax code', () => {
    for (const code of KEPT_TS_CODES) expect(NOISY_TS_CODES).not.toContain(code);
    expect(NOISY_TS_CODES.filter((code) => code >= 1000 && code < 2000)).toEqual([]);
  });

  it('ignores the noisy type-checking codes of plain browser JavaScript', () => {
    for (const code of [2339, 2322, 2345, 2531, 2307, 2580])
      expect(JS_DIAGNOSTICS_OPTIONS.diagnosticCodesToIgnore).toContain(code);
    expect(JS_DIAGNOSTICS_OPTIONS.noSuggestionDiagnostics).toBe(true);
  });

  it('CSS keeps unknown properties and bad values, drops style opinions', () => {
    expect(CSS_LINT.unknownProperties).toBe('warning');
    expect(CSS_LINT.hexColorLength).toBe('error');
    expect(CSS_LINT.argumentsInColorFunction).toBe('error');
    for (const opinion of ['emptyRules', 'zeroUnits', 'idSelector', 'important', 'vendorPrefix', 'boxModel'])
      expect(CSS_LINT[opinion]).toBe('ignore');
  });
});
