import { describe, expect, it } from 'vitest';
import { aboutLine, aboutVersions, OPEN_ABOUT_EVENT, openAbout } from './about';

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) noobide/0.0.0 ' +
  'Chrome/146.0.7680.65 Electron/44.7.0 Safari/537.36';

describe('About versions (S28.1)', () => {
  it('reads Electron and Chromium from the user agent and keeps the app version', () => {
    expect(aboutVersions('1.2.3', UA)).toEqual({ app: '1.2.3', electron: '44.7.0', chromium: '146.0.7680.65' });
  });

  it('reports missing runtime versions as null instead of guessing', () => {
    expect(aboutVersions('1.2.3', 'Mozilla/5.0')).toEqual({ app: '1.2.3', electron: null, chromium: null });
  });

  it('formats one copyable line', () => {
    expect(aboutLine(aboutVersions('1.2.3', UA))).toBe('NoobIDE 1.2.3 (Electron 44.7.0, Chromium 146.0.7680.65)');
    expect(aboutLine(aboutVersions('1.2.3', ''))).toBe('NoobIDE 1.2.3');
  });

  it('openAbout dispatches the event the workbench listens for', () => {
    const target = new EventTarget();
    let opened = 0;
    target.addEventListener(OPEN_ABOUT_EVENT, () => (opened += 1));
    openAbout(target);
    expect(opened).toBe(1);
  });
});
