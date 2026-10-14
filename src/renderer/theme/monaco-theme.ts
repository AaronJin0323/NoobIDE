import type { editor } from 'monaco-editor/editor';
import { THEMES, type ColorScheme } from './tokens';

/** Monaco theme names registered by monaco-setup.ts (S30.2). */
export const MONACO_THEME_NAME: Record<ColorScheme, string> = {
  dark: 'noobide-dark',
  light: 'noobide-light',
};

/** Monaco token rules take colours without the leading '#'. */
const bare = (hex: string) => hex.slice(1);

/** Builds the editor theme from the same tokens as the shell, so the editor never stands out as a white box. */
export function buildMonacoTheme(scheme: ColorScheme): editor.IStandaloneThemeData {
  const t = THEMES[scheme];
  return {
    base: scheme === 'dark' ? 'vs-dark' : 'vs',
    inherit: true,
    rules: [
      { token: '', foreground: bare(t.text) },
      { token: 'tag', foreground: bare(t.syntaxTag) },
      // The base themes colour the doctype per language (grey / red in 'vs'); override the specific tokens too.
      { token: 'metatag', foreground: bare(t.syntaxTag) },
      { token: 'metatag.html', foreground: bare(t.syntaxTag) },
      { token: 'metatag.content.html', foreground: bare(t.syntaxTag) },
      { token: 'delimiter.html', foreground: bare(t.syntaxTag) },
      { token: 'attribute.name', foreground: bare(t.syntaxAttribute) },
      { token: 'attribute.value', foreground: bare(t.syntaxString) },
      { token: 'string', foreground: bare(t.syntaxString) },
      { token: 'comment', foreground: bare(t.syntaxComment), fontStyle: 'italic' },
      { token: 'keyword', foreground: bare(t.syntaxKeyword) },
      { token: 'number', foreground: bare(t.syntaxNumber) },
      { token: 'tag.css', foreground: bare(t.syntaxTag) },
      { token: 'attribute.name.css', foreground: bare(t.syntaxAttribute) },
      { token: 'attribute.value.css', foreground: bare(t.syntaxString) },
    ],
    colors: {
      'editor.background': t.panel,
      'editor.foreground': t.text,
      'editorGutter.background': t.panel,
      'editorLineNumber.foreground': t.faint,
      'editorLineNumber.activeForeground': t.text,
      'editor.lineHighlightBackground': t.lineHighlight,
      'editor.lineHighlightBorder': t.lineHighlight,
      'editor.selectionBackground': t.selection,
      'editorCursor.foreground': t.accentText,
      'editorIndentGuide.background1': t.line,
      'editorWidget.background': t.raised,
      'editorWidget.border': t.line,
      'editorSuggestWidget.background': t.raised,
      'editorSuggestWidget.selectedBackground': t.hover,
      'editorOverviewRuler.border': t.panel,
      'scrollbarSlider.background': `${t.line}CC`,
      'scrollbarSlider.hoverBackground': t.hover,
      'scrollbarSlider.activeBackground': t.hover,
      focusBorder: t.focus,
    },
  };
}
