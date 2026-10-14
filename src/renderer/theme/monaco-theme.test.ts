import { describe, expect, it } from 'vitest';
import { MONACO_THEME_NAME, buildMonacoTheme } from './monaco-theme';
import { THEMES, type ColorScheme } from './tokens';

describe('Monaco theme from shell tokens (S30.2)', () => {
  it.each<ColorScheme>(['dark', 'light'])('%s: editor surfaces use the panel tokens', (scheme) => {
    const theme = buildMonacoTheme(scheme);
    const t = THEMES[scheme];
    expect(theme.base).toBe(scheme === 'dark' ? 'vs-dark' : 'vs');
    expect(theme.colors['editor.background']).toBe(t.panel);
    expect(theme.colors['editorGutter.background']).toBe(t.panel);
    expect(theme.colors['editor.foreground']).toBe(t.text);
    expect(theme.colors['editorLineNumber.foreground']).toBe(t.faint);
  });

  it.each<ColorScheme>(['dark', 'light'])('%s: syntax rules use the checked syntax tokens', (scheme) => {
    const t = THEMES[scheme];
    const rule = (token: string) => buildMonacoTheme(scheme).rules.find((r) => r.token === token)?.foreground;
    expect(rule('tag')).toBe(t.syntaxTag.slice(1));
    expect(rule('attribute.name')).toBe(t.syntaxAttribute.slice(1));
    expect(rule('attribute.value')).toBe(t.syntaxString.slice(1));
    expect(rule('comment')).toBe(t.syntaxComment.slice(1));
    expect(rule('keyword')).toBe(t.syntaxKeyword.slice(1));
    // The doctype must not fall back to the base theme's per-language colours.
    expect(rule('metatag.html')).toBe(t.syntaxTag.slice(1));
    expect(rule('metatag.content.html')).toBe(t.syntaxTag.slice(1));
  });

  it('registers one distinct theme name per scheme', () => {
    expect(MONACO_THEME_NAME).toEqual({ dark: 'noobide-dark', light: 'noobide-light' });
  });
});
