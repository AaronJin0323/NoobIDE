import { describe, expect, it } from 'vitest';
import { INITIAL_LAYOUT, layoutReducer, persistedLayout, visibleRegions, type LayoutState } from './layout';

describe('workbench layout (S30.3, S30.4)', () => {
  it('wide window starts with files, editor and preview visible and problems collapsed', () => {
    expect(visibleRegions(INITIAL_LAYOUT, false)).toEqual({
      files: true,
      editor: true,
      preview: true,
      problemsPanel: false,
      narrowSwitch: false,
    });
  });

  it('narrow window starts on code with files collapsed and shows the switch', () => {
    expect(visibleRegions(INITIAL_LAYOUT, true)).toEqual({
      files: false,
      editor: true,
      preview: false,
      problemsPanel: false,
      narrowSwitch: true,
    });
  });

  it('the switch shows exactly one of code and preview', () => {
    const preview = layoutReducer(INITIAL_LAYOUT, { type: 'showNarrowView', view: 'preview' });
    expect(visibleRegions(preview, true)).toMatchObject({ editor: false, preview: true });
    const code = layoutReducer(preview, { type: 'showNarrowView', view: 'code' });
    expect(visibleRegions(code, true)).toMatchObject({ editor: true, preview: false });
    // A wide window always shows both, whatever the narrow choice was.
    expect(visibleRegions(preview, false)).toMatchObject({ editor: true, preview: true });
  });

  it('files toggle is remembered separately for wide and narrow windows', () => {
    const wideClosed = layoutReducer(INITIAL_LAYOUT, { type: 'toggleFiles', narrow: false });
    expect(visibleRegions(wideClosed, false).files).toBe(false);
    expect(visibleRegions(wideClosed, true).files).toBe(false);
    const narrowOpen = layoutReducer(wideClosed, { type: 'toggleFiles', narrow: true });
    expect(visibleRegions(narrowOpen, true).files).toBe(true);
    expect(visibleRegions(narrowOpen, false).files).toBe(false);
  });

  it('choosing a narrow view closes the file drawer that would cover it', () => {
    const drawer: LayoutState = { ...INITIAL_LAYOUT, filesOpenNarrow: true };
    expect(layoutReducer(drawer, { type: 'showNarrowView', view: 'preview' }).filesOpenNarrow).toBe(false);
  });

  it('problems toggles open and closed', () => {
    const open = layoutReducer(INITIAL_LAYOUT, { type: 'toggleProblems' });
    expect(visibleRegions(open, false).problemsPanel).toBe(true);
    expect(layoutReducer(open, { type: 'toggleProblems' }).problemsOpen).toBe(false);
  });
});

describe('layout sizes (S13.4)', () => {
  it('starts at 220px files and an even editor / preview split', () => {
    expect(persistedLayout(INITIAL_LAYOUT)).toEqual({
      filesOpen: true,
      problemsOpen: false,
      filesWidth: 220,
      editorShare: 0.5,
    });
  });

  it('resizing is clamped to sensible limits', () => {
    expect(layoutReducer(INITIAL_LAYOUT, { type: 'resizeFiles', width: 300.4 }).filesWidth).toBe(300);
    expect(layoutReducer(INITIAL_LAYOUT, { type: 'resizeFiles', width: 10 }).filesWidth).toBe(160);
    expect(layoutReducer(INITIAL_LAYOUT, { type: 'resizeFiles', width: Infinity }).filesWidth).toBe(480);
    expect(layoutReducer(INITIAL_LAYOUT, { type: 'resizeEditor', share: 0.6543 }).editorShare).toBe(0.654);
    expect(layoutReducer(INITIAL_LAYOUT, { type: 'resizeEditor', share: -Infinity }).editorShare).toBe(0.2);
    expect(layoutReducer(INITIAL_LAYOUT, { type: 'resizeEditor', share: 2 }).editorShare).toBe(0.8);
  });

  it('a restored layout comes back exactly, and round-trips through persistedLayout', () => {
    const saved = { filesOpen: false, problemsOpen: true, filesWidth: 333, editorShare: 0.65 };
    const restored = layoutReducer(INITIAL_LAYOUT, { type: 'restoreLayout', layout: saved });
    expect(persistedLayout(restored)).toEqual(saved);
    expect(visibleRegions(restored, false).files).toBe(false);
    expect(visibleRegions(restored, false).problemsPanel).toBe(true);
  });
});
