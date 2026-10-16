/**
 * S45.4: the shared sheet anatomy. Renders <Sheet> to markup (no DOM needed) and checks the order and the dialog
 * semantics, and scans the renderer so every modal dialog is built on <Sheet> (one anatomy by construction).
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Sheet, type SheetProps } from './Sheet';

function render(props: Partial<SheetProps>): string {
  return renderToStaticMarkup(
    h(Sheet, {
      title: 'Title',
      testId: 'sheet',
      onEscape: () => undefined,
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
  it('orders title, description, content, then the trailing actions (Cancel before the primary)', () => {
    const html = render({
      description: 'One sentence.',
      actions: [
        h('button', { key: 'c', className: 'secondary-button', 'data-role': 'cancel' }, 'Cancel'),
        h('button', { key: 'p', className: 'primary-button', 'data-role': 'primary' }, 'Create'),
      ],
    });
    const title = indexOf(html, '<h2');
    const description = indexOf(html, 'sheet-description');
    const content = indexOf(html, 'class="sheet-content"');
    const actions = indexOf(html, 'sheet-actions');
    expect(title).toBeLessThan(description);
    expect(description).toBeLessThan(content);
    expect(content).toBeLessThan(actions);
    expect(indexOf(html, 'data-role="cancel"')).toBeLessThan(indexOf(html, 'data-role="primary"'));
  });

  it('is a modal dialog named by its title and described by its description', () => {
    const html = render({ description: 'One sentence.' });
    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="true"');
    expect(html).toContain('data-sheet=""');
    const labelledBy = /aria-labelledby="([^"]+)"/.exec(html)?.[1];
    const describedBy = /aria-describedby="([^"]+)"/.exec(html)?.[1];
    expect(html).toContain(`<h2 class="dialog-title sheet-title" id="${labelledBy}">Title</h2>`);
    expect(html).toContain(`<p class="sheet-description" id="${describedBy}">One sentence.</p>`);
  });

  it('an alert is described by its content (the question)', () => {
    const html = render({ role: 'alertdialog' });
    expect(html).toContain('role="alertdialog"');
    const describedBy = /aria-describedby="([^"]+)"/.exec(html)?.[1];
    expect(html).toContain(`<div class="sheet-content" id="${describedBy}">`);
  });

  it('puts leading content first in the action row, and leaves the row out when there is nothing to act on', () => {
    const html = render({ leading: h('span', { className: 'lead' }, 'Usage'), actions: h('button', null, 'Close') });
    expect(indexOf(html, 'sheet-actions-leading')).toBeLessThan(indexOf(html, '<button'));
    expect(render({})).not.toContain('sheet-actions');
  });

  it('keeps a hidden title for screen readers (the palette) and applies the size', () => {
    const html = render({ titleHidden: true, size: 'large', className: 'palette' });
    expect(html).toContain('class="sheet-header sr-only"');
    expect(html).toContain('class="sheet sheet-large palette"');
  });
});

describe('every modal dialog uses the shared sheet', () => {
  const renderer = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const files = (readdirSync(renderer, { recursive: true }) as string[])
    .filter((f) => f.endsWith('.tsx'))
    .map((f) => path.join(renderer, f));
  /** Not a Sheet yet: the AI settings dialog belongs to the AI area (S45.5 or later). */
  const notYet = new Set(['ai/AiSettingsDialog.tsx']);

  it('no component other than Sheet sets aria-modal itself', () => {
    const own = files
      .filter((f) => /aria-modal/.test(readFileSync(f, 'utf8')))
      .map((f) => path.relative(renderer, f).split(path.sep).join('/'))
      .filter((f) => f !== 'workbench/Sheet.tsx' && !notYet.has(f));
    expect(own).toEqual([]);
  });

  it.each([
    'history/HistoryDialog.tsx',
    'recovery/RecoveryDialog.tsx',
    'welcome/CreateProjectDialog.tsx',
    'workbench/ConfirmDialog.tsx',
    'workbench/AboutDialog.tsx',
    'walkthrough/GlossaryDialog.tsx',
    'commands/CommandPalette.tsx',
  ])('%s renders a <Sheet>', (file) => {
    expect(readFileSync(path.join(renderer, file), 'utf8')).toMatch(/<Sheet\b/);
  });
});
