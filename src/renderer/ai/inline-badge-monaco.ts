/**
 * S43.7 (decision 0032): an "AI" badge next to AI ghost text, so a beginner can tell an AI suggestion from the
 * language service's suggestion list. Shown when Monaco displays an S32.1 suggestion (`handleItemDidShow`) and removed
 * when that suggestion ends (accepted, dismissed, replaced) or the cursor, text, focus or file changes.
 *
 * The badge is a Monaco content widget: text ("AI") plus an accessible name and tooltip, so it never relies on colour.
 */
import { monaco } from '../editor/monaco-setup';
import { DEFAULT_LOCALE, isLocale, translate } from '../i18n/index';

const WIDGET_ID = 'noobide.aiGhostBadge';
/** Monaco's ghost text (same selectors as tests/e2e/ai-inline.spec.ts). */
const GHOST_TEXT = '.ghost-text-decoration, .ghost-text';

function locale() {
  const lang = document.documentElement.lang;
  return isLocale(lang) ? lang : DEFAULT_LOCALE;
}

class Badge implements monaco.editor.IContentWidget {
  readonly allowEditorOverflow = false;
  readonly suppressMouseDown = true;
  private readonly node: HTMLElement;
  private position: monaco.IPosition | null = null;
  private visible = false;
  private frame = 0;
  /** The suggestion list the badge belongs to; only its end hides the badge. */
  owner: object | null = null;
  private readonly subscriptions: monaco.IDisposable[];

  constructor(private readonly editor: monaco.editor.ICodeEditor) {
    this.node = document.createElement('span');
    this.node.className = 'ai-ghost-badge';
    this.node.dataset.testid = 'ai-ghost-badge';
    this.node.setAttribute('role', 'note');
    const hide = () => this.hide();
    // Typing what the suggestion says keeps it on screen (Monaco does not report it as shown again): the badge stays
    // while grey text is still there, moved to the cursor, and goes with it.
    const recheck = () => {
      if (!this.visible) return;
      if (this.frame) cancelAnimationFrame(this.frame);
      this.frame = requestAnimationFrame(() => {
        this.frame = 0;
        const position = editor.getPosition();
        if (!this.visible || !position) return;
        if (editor.getDomNode()?.querySelector(GHOST_TEXT)) this.move(position);
        else this.hide();
      });
    };
    this.subscriptions = [
      editor.onDidChangeModelContent(recheck),
      editor.onDidChangeCursorPosition(recheck),
      editor.onDidChangeModel(hide),
      editor.onDidBlurEditorText(hide),
      editor.onKeyDown((event) => {
        if (event.keyCode === monaco.KeyCode.Escape) hide();
      }),
    ];
  }

  getId(): string {
    return WIDGET_ID;
  }

  getDomNode(): HTMLElement {
    return this.node;
  }

  getPosition(): monaco.editor.IContentWidgetPosition | null {
    if (!this.position) return null;
    const { ABOVE, BELOW } = monaco.editor.ContentWidgetPositionPreference;
    return { position: this.position, preference: [ABOVE, BELOW] };
  }

  private move(position: monaco.IPosition): void {
    this.position = position;
    this.editor.layoutContentWidget(this);
  }

  show(position: monaco.IPosition): void {
    const lang = locale();
    this.node.textContent = translate(lang, 'smartEdit.aiBadge');
    const title = translate(lang, 'smartEdit.aiBadge.title');
    this.node.title = title;
    this.node.setAttribute('aria-label', title);
    this.position = position;
    if (this.visible) this.editor.layoutContentWidget(this);
    else this.editor.addContentWidget(this);
    this.visible = true;
  }

  hide(): void {
    this.owner = null;
    if (!this.visible) return;
    this.visible = false;
    this.position = null;
    this.editor.removeContentWidget(this);
  }

  dispose(): void {
    if (this.frame) cancelAnimationFrame(this.frame);
    this.hide();
    for (const subscription of this.subscriptions) subscription.dispose();
  }
}

const badges = new WeakMap<monaco.editor.ICodeEditor, Badge>();

/** Gives `editor` an AI badge; the inline provider shows and hides it. */
export function attachAiBadge(editor: monaco.editor.ICodeEditor): monaco.IDisposable {
  const badge = new Badge(editor);
  badges.set(editor, badge);
  return {
    dispose: () => {
      badges.delete(editor);
      badge.dispose();
    },
  };
}

export function showAiBadge(editor: monaco.editor.ICodeEditor, position: monaco.IPosition, owner: object): void {
  // Only while the suggestion still belongs to where the cursor is.
  const now = editor.getPosition();
  const badge = badges.get(editor);
  if (!badge || !now || now.lineNumber !== position.lineNumber || now.column !== position.column) return;
  badge.show(now);
  badge.owner = owner;
}

/** The suggestion list `owner` ended; a badge shown for a newer list stays. */
export function hideAiBadge(editor: monaco.editor.ICodeEditor, owner: object): void {
  const badge = badges.get(editor);
  if (badge?.owner === owner) badge.hide();
}
