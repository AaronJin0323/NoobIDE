import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  FRAME,
  INITIAL_LAYOUT,
  frameMinimums,
  layoutReducer,
  persistedLayout,
  visibleRegions,
  type LayoutState,
} from './layout';

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

describe('vertical budget: the status strip and the Problems toggle never leave the window', () => {
  const css = (file: string) => readFileSync(path.join(__dirname, file), 'utf8').replace(/\s+/g, ' ');

  it('never needs more height than the window has, down to the 640x480 minimum window', () => {
    for (let height = 440; height <= 1400; height += 1) {
      for (const walkthrough of [false, true]) {
        for (const problems of [false, true]) {
          for (const narrow of [false, true]) {
            for (const notice of [false, true]) {
              const m = frameMinimums(height, { walkthrough, problems, narrow, notice });
              expect(m.total).toBeLessThanOrEqual(height);
              expect(m.middle).toBeGreaterThan(0);
            }
          }
        }
      }
    }
  });

  it('keeps the 430 px middle row at 1280x720 with the walkthrough and Problems open (no loss for the preview)', () => {
    expect(frameMinimums(720, { walkthrough: true, problems: true, narrow: false }).middle).toBe(430);
    expect(frameMinimums(720, { walkthrough: true, problems: true, narrow: false }).problems).toBe(100 + FRAME.gap);
    // A 1366x768 laptop (about 677 px of content) and 1080p at 150 % (about 637 px).
    expect(frameMinimums(677, { walkthrough: true, problems: true, narrow: false }).middle).toBe(430);
    expect(frameMinimums(637, { walkthrough: true, problems: true, narrow: false }).middle).toBe(409);
  });

  it('matches the CSS that applies it', () => {
    const styles = css('../styles.css');
    expect(styles).toContain(`--topbar-h: ${FRAME.topbar}px;`);
    expect(styles).toContain(`--strip-h: ${FRAME.strip}px;`);
    expect(styles).toContain(
      `--problems-panel-min: clamp(${FRAME.problemsMin.floor}px, calc(100vh - ${FRAME.problemsMin.offset}px), ${FRAME.problemsMin.ceiling}px);`,
    );
    expect(styles).toContain(
      `min( ${FRAME.middleMax}px, calc( 100vh - var(--topbar-h) - var(--strip-h) - var(--walkthrough-reserve) - var(--problems-reserve) - var(--notice-reserve) ) )`,
    );
    expect(styles).toContain(
      `--notice-reserve: clamp(${FRAME.noticeMin.floor}px, calc(100vh - ${FRAME.noticeMin.offset}px), ${FRAME.noticeMin.ceiling}px);`,
    );
    // A flex-shrink below 1 would remove only that share of the overflow and push the status strip off the window.
    expect(css('../walkthrough/walkthrough.css')).toMatch(/\.walkthrough \{[^}]*flex: 0 1 auto;/);
    expect(styles).toMatch(/body \{[^}]*overflow: hidden;/);
    expect(styles).toMatch(/\.status-strip \{[^}]*flex: none;/);
    // Problems is sized to its content (up to a cap), not a fixed 260 px.
    expect(styles).toMatch(/\.problems-panel:not\(\[hidden\]\) \{[^}]*flex: 0 1 auto;[^}]*max-height: 260px;/);
    const walkthrough = css('../walkthrough/walkthrough.css');
    expect(walkthrough).toContain(`--walkthrough-min: ${FRAME.walkthroughMin.wide}px;`);
    expect(walkthrough).toContain(`--walkthrough-min: ${FRAME.walkthroughMin.narrow}px;`);
    expect(walkthrough).toMatch(/\.walkthrough-actions \{[^}]*flex-wrap: nowrap;/);
  });
});
