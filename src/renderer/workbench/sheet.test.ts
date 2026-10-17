/**
 * S49.1: the one Sheet shell. Renders <Sheet> and the dialogs built on it to static markup (vitest runs without a
 * DOM) and checks the anatomy — title, Close top-right, description, scrolling content, then the action row with
 * Cancel before the primary, destructive verbs drawn with the danger style — plus the pure rules of the focus trap
 * and of Escape. A scan of the renderer keeps every modal dialog on the shell (no component sets aria-modal itself).
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createElement as h, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../i18n/I18nProvider';
import { ConfirmDialog } from './ConfirmDialog';
import { tabWrapTarget } from './focus-trap';
import { escapeAction, Sheet, sheetButtonClass, type SheetProps } from './Sheet';

function render(props: Partial<SheetProps> & { children?: ReactNode }): string {
  return renderToStaticMarkup(
    h(Sheet, {
      title: 'Title',
      closeLabel: 'Close',
      testId: 'sheet',
      onClose: () => undefined,
      children: h('p', { className: 'body' }, 'Body'),
      ...props,
    } as SheetProps),
  );
}

const indexOf = (html: string, needle: string) => {
  const at = html.indexOf(needle);
  expect(at, needle).toBeGreaterThanOrEqual(0);
  return at;
};

describe('Sheet anatomy', () => {
  it('orders the title row (with Close top-right), the description, the content, then Cancel → Primary', () => {
    const html = render({
      description: 'One sentence.',
      actions: [
        h('button', { key: 'c', className: sheetButtonClass('cancel'), 'data-role': 'cancel' }, 'Cancel'),
        h('button', { key: 'p', className: sheetButtonClass('primary'), 'data-role': 'primary' }, 'Create'),
      ],
    });
    const header = indexOf(html, 'class="sheet-header"');
    const title = indexOf(html, '<h2');
    const close = indexOf(html, 'sheet-close');
    const description = indexOf(html, 'sheet-description');
    const content = indexOf(html, 'class="sheet-content"');
    const body = indexOf(html, 'class="body"');
    const actions = indexOf(html, 'sheet-actions');
    expect(header).toBeLessThan(title);
    expect(title).toBeLessThan(close);
    expect(close).toBeLessThan(description);
    expect(description).toBeLessThan(content);
    expect(content).toBeLessThan(body);
    expect(body).toBeLessThan(actions);
    expect(indexOf(html, 'data-role="cancel"')).toBeLessThan(indexOf(html, 'data-role="primary"'));
    // The one shell carries the overlay classes glass.css and the preview cover rule key on.
    expect(html).toMatch(/<div class="dialog-backdrop">/);
    expect(html).toContain('class="dialog sheet sheet-480"');
  });

  it('is a modal dialog named by its title and described by its description; Close carries the caller’s word', () => {
    const html = render({ description: 'One sentence.', closeLabel: 'Decide later', closeTestId: 'x' });
    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="true"');
    expect(html).toContain('data-sheet=""');
    const labelledBy = /aria-labelledby="([^"]+)"/.exec(html)?.[1];
    const describedBy = /aria-describedby="([^"]+)"/.exec(html)?.[1];
    expect(html).toContain(`<h2 class="dialog-title sheet-title" id="${labelledBy}">Title</h2>`);
    expect(html).toContain(`<p class="dialog-hint sheet-description" id="${describedBy}">One sentence.</p>`);
    expect(html).toMatch(
      /<button type="button" class="icon-button sheet-close" aria-label="Decide later" title="Decide later" data-testid="x">/,
    );
  });

  it('an alert is described by its content (the question), and a disabled Close is drawn disabled', () => {
    const html = render({ role: 'alertdialog', closeDisabled: true });
    expect(html).toContain('role="alertdialog"');
    const describedBy = /aria-describedby="([^"]+)"/.exec(html)?.[1];
    expect(html).toContain(`<div class="sheet-content" id="${describedBy}">`);
    expect(html).toMatch(/sheet-close" aria-label="Close" title="Close" disabled=""/);
  });

  it('puts leading content first in the action row, and leaves the row out when there is nothing to act on', () => {
    const html = render({ leading: h('span', { className: 'lead' }, 'Usage'), actions: h('button', null, 'Later') });
    expect(indexOf(html, 'sheet-actions-leading')).toBeLessThan(indexOf(html, '<button>Later'));
    expect(render({})).not.toContain('sheet-actions');
  });

  it('takes a width from the scale, an icon before the title and feature classes', () => {
    const html = render({
      width: 960,
      className: 'history-dialog',
      backdropClassName: 'history-backdrop',
      titleIcon: h('svg', { 'data-icon': '' }),
    });
    expect(html).toContain('class="dialog-backdrop history-backdrop"');
    expect(html).toContain('class="dialog sheet sheet-960 history-dialog"');
    expect(html).toMatch(/<h2 [^>]*><span class="sheet-title-icon"><svg data-icon=""><\/svg><\/span>Title<\/h2>/);
  });
});

describe('sheet buttons', () => {
  it('names one class per job: quiet Cancel, the filled primary, the danger primary', () => {
    expect(sheetButtonClass('cancel')).toBe('quiet-button dialog-button');
    expect(sheetButtonClass('primary')).toBe('primary-button dialog-button');
    expect(sheetButtonClass('danger')).toBe('primary-button danger-button dialog-button');
  });

  it('the danger style exists in the stylesheet, as a fill for the primary and red text otherwise', () => {
    const css = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'styles.css'), 'utf8');
    expect(css).toMatch(/\.danger-button\s*\{\s*color: var\(--danger\);/);
    expect(css).toMatch(/\.primary-button\.danger-button\s*\{\s*background: var\(--danger\);/);
  });
});

describe('ConfirmDialog on the Sheet', () => {
  const confirm = (tone?: 'default' | 'danger') =>
    renderToStaticMarkup(
      h(
        I18nProvider,
        null,
        h(ConfirmDialog, {
          title: 'Move to trash?',
          confirmLabel: 'Move to trash',
          cancelLabel: 'Cancel',
          tone,
          onConfirm: () => undefined,
          onCancel: () => undefined,
          testId: 'delete-dialog',
          children: h('p', null, 'Question'),
        }),
      ),
    );

  it('is an alert with Cancel (focused first) before the confirming verb, destructive when asked', () => {
    const html = confirm('danger');
    expect(html).toContain('role="alertdialog"');
    expect(html).toContain('data-testid="delete-dialog"');
    const cancel = indexOf(html, 'class="quiet-button dialog-button" data-autofocus="true"');
    const verb = indexOf(html, 'class="primary-button danger-button dialog-button" data-testid="confirm-button"');
    expect(cancel).toBeLessThan(verb);
    expect(html).toContain('>Cancel</button>');
    // The X is "Close" (zh-CN by default): Cancel stays the one control named Cancel.
    expect(html).toMatch(/sheet-close" aria-label="关闭"/);
    expect(html).toContain('>Move to trash</button>');
    // The plain tone keeps the ordinary primary.
    expect(confirm()).toContain('class="primary-button dialog-button" data-testid="confirm-button"');
  });
});

describe('focus trap rule (focus-trap.ts tabWrapTarget)', () => {
  const items = ['close', 'field', 'cancel', 'primary'] as const;
  it('wraps Tab from the last control to the first and Shift+Tab from the first to the last', () => {
    expect(tabWrapTarget(items, 'primary', false, true)).toBe('close');
    expect(tabWrapTarget(items, 'close', true, true)).toBe('primary');
  });
  it('leaves the browser order alone inside the sheet, and pulls focus back in from the page', () => {
    expect(tabWrapTarget(items, 'field', false, true)).toBeNull();
    expect(tabWrapTarget(items, 'cancel', true, true)).toBeNull();
    expect(tabWrapTarget(items, null, false, false)).toBe('close');
    expect(tabWrapTarget(items, null, true, false)).toBe('primary');
    expect(tabWrapTarget([], null, false, false)).toBeNull();
  });
});

describe('Escape in a sheet (escapeAction)', () => {
  it('closes, unless the caller handles it first or closing is disabled while work runs', () => {
    const onClose = vi.fn();
    const onEscape = vi.fn();
    expect(escapeAction({ closeDisabled: false, onClose })).toBe('close');
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(escapeAction({ closeDisabled: false, onEscape, onClose })).toBe('escape');
    expect(onEscape).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(escapeAction({ closeDisabled: true, onEscape, onClose })).toBe('none');
    expect(onEscape).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe('every modal dialog uses the shared sheet', () => {
  const renderer = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const files = readdirSync(renderer, { recursive: true, encoding: 'utf8' })
    .filter((f) => f.endsWith('.tsx') && !f.includes('.test.'))
    .map((f) => path.join(renderer, f));
  /** The command palette is a search field with a list, not a titled dialog (S40.5); it keeps its own shell. */
  const ownShell = new Set(['commands/CommandPalette.tsx']);

  it('no component other than Sheet sets aria-modal itself', () => {
    const own = files
      .filter((f) => /aria-modal/.test(readFileSync(f, 'utf8')))
      .map((f) => path.relative(renderer, f).split(path.sep).join('/'))
      .filter((f) => f !== 'workbench/Sheet.tsx' && !ownShell.has(f));
    expect(own).toEqual([]);
  });

  it.each([
    'history/HistoryDialog.tsx',
    'recovery/RecoveryDialog.tsx',
    'ai/AiSettingsDialog.tsx',
    'walkthrough/GlossaryDialog.tsx',
    'welcome/CreateProjectDialog.tsx',
    'workbench/ConfirmDialog.tsx',
    'workbench/AboutDialog.tsx',
  ])('%s renders a <Sheet>', (file) => {
    const source = readFileSync(path.join(renderer, file), 'utf8');
    expect(source).toMatch(/<Sheet\b/);
    // A sheet with a field never closes on a backdrop click (typed input is never lost).
    if (/<(input|select|textarea)\b/.test(source)) expect(source).not.toContain('dismissOnBackdrop');
  });

  it('inline confirmations put Cancel before the destructive verb and draw the verb with the danger style', () => {
    for (const file of ['recovery/RecoveryDialog.tsx', 'history/HistoryDialog.tsx', 'ai/SavedChatsList.tsx']) {
      const source = readFileSync(path.join(renderer, file), 'utf8');
      // Every destructive confirm button is a danger button…
      for (const id of source.match(
        /data-testid="[a-z-]*(confirm-clear|confirm-delete|discard-confirm|clear-confirm|orphan-confirm)"/g,
      ) ?? []) {
        const at = source.indexOf(id);
        const button = source.slice(source.lastIndexOf('<button', at), at);
        expect(button, `${file} ${id}`).toContain('danger-button');
        // …and the Cancel button of its pair comes before it in the markup.
        const cancelAt = source.lastIndexOf(".cancel')", at);
        expect(cancelAt, `${file} ${id}: Cancel before the verb`).toBeGreaterThan(source.lastIndexOf('? (', at));
      }
    }
  });
});
