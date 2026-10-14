import { describe, expect, it } from 'vitest';
import { INITIAL_LAYOUT, layoutReducer, visibleRegions, type LayoutState } from './layout';

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
