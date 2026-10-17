import { describe, expect, it } from 'vitest';
import { INITIAL_LAYOUT, layoutReducer, visibleRegions } from './layout';
import {
  DRAG_DEAD_ZONE,
  FILES_COLLAPSE_BELOW,
  SPLITTER_DEFAULTS,
  beginDrag,
  cancelDrag,
  editorShareValueText,
  endDrag,
  filesDragOutcome,
  filesValueText,
  moveDrag,
} from './splitter-model';

const px = (start: number, dx: number) => start + dx;

describe('splitter physics (S49.1)', () => {
  it('uses the planned constants', () => {
    expect(DRAG_DEAD_ZONE).toBe(4);
    expect(FILES_COLLAPSE_BELOW).toBe(120);
    expect(SPLITTER_DEFAULTS).toEqual({ filesWidth: 220, editorShare: 0.5 });
  });

  it('a press becomes a drag only after 4 px of movement, in either direction', () => {
    const pressed = beginDrag(100, 220);
    expect(moveDrag(pressed, 103, px)).toEqual({ state: pressed, value: null, started: false });
    expect(moveDrag(pressed, 97, px).value).toBeNull();
    const right = moveDrag(pressed, 104, px);
    expect(right).toEqual({ state: { ...pressed, active: true }, value: 224, started: true });
    expect(moveDrag(pressed, 96, px).value).toBe(216);
  });

  it('once dragging, moving back inside the dead zone keeps following the pointer', () => {
    const dragging = moveDrag(beginDrag(100, 220), 110, px).state;
    const back = moveDrag(dragging, 101, px);
    expect(back.value).toBe(221);
    expect(back.started).toBe(false);
  });

  it('a click (release inside the dead zone) changes nothing; a drag applies the release position', () => {
    expect(endDrag(beginDrag(100, 220), 102, px)).toBeNull();
    const dragging = moveDrag(beginDrag(100, 220), 130, px).state;
    expect(endDrag(dragging, 140, px)).toBe(260);
  });

  it('Escape restores the start value of a drag and leaves a click alone', () => {
    expect(cancelDrag(beginDrag(100, 0.5))).toBeNull();
    expect(cancelDrag(moveDrag(beginDrag(100, 0.5), 160, (s, dx) => s + dx / 1000).state)).toBe(0.5);
  });

  it('the files panel collapses under 120 px and keeps the start width for the toggle', () => {
    expect(filesDragOutcome(119, 300)).toEqual({ open: false, width: 300 });
    expect(filesDragOutcome(-50, 300)).toEqual({ open: false, width: 300 });
    expect(filesDragOutcome(120, 300)).toEqual({ open: true, width: 160 }); // reopened at the narrowest open width
    expect(filesDragOutcome(250.4, 300)).toEqual({ open: true, width: 250 });
    expect(filesDragOutcome(900, 300)).toEqual({ open: true, width: 480 });
  });

  it('a collapsing drag puts the layout in the same state as toggle-files, and dragging back out reopens it', () => {
    const toggled = layoutReducer(INITIAL_LAYOUT, { type: 'toggleFiles', narrow: false });
    const dragged = layoutReducer(INITIAL_LAYOUT, { type: 'dragFiles', width: 80, startWidth: 220 });
    expect(dragged).toEqual(toggled);
    expect(visibleRegions(dragged, false).files).toBe(false);
    const reopened = layoutReducer(dragged, { type: 'dragFiles', width: 200, startWidth: 220 });
    expect(reopened).toEqual({ ...INITIAL_LAYOUT, filesWidth: 200 });
    expect(visibleRegions(reopened, false).files).toBe(true);
  });

  it('announces the sizes in words in both locales', () => {
    const zh = { width: '文件面板宽 {px} 像素', collapsed: '文件面板已收起' };
    const en = { width: 'Files panel {px} pixels wide', collapsed: 'Files panel collapsed' };
    expect(filesValueText(220, true, zh)).toBe('文件面板宽 220 像素');
    expect(filesValueText(220, false, zh)).toBe('文件面板已收起');
    expect(filesValueText(301.6, true, en)).toBe('Files panel 302 pixels wide');
    expect(editorShareValueText(0.62, '代码占 {code}%，预览占 {preview}%')).toBe('代码占 62%，预览占 38%');
    expect(editorShareValueText(0.5, 'Code {code} percent, preview {preview} percent')).toBe(
      'Code 50 percent, preview 50 percent',
    );
  });
});
