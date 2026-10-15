import { describe, expect, it } from 'vitest';
import { editBlocked } from './edit-lock';

const tab = (readOnly?: boolean) => ({ content: readOnly === undefined ? {} : { readOnly } });

describe('AI edits and the rename / move / trash lock', () => {
  it('a read-only tab is blocked', () => {
    expect(editBlocked('index.html', tab(true), [])).toBe(true);
    expect(editBlocked('index.html', tab(false), [])).toBe(false);
    expect(editBlocked('index.html', tab(), [])).toBe(false);
  });

  it('a file being renamed, moved or trashed — itself or a folder holding it — is blocked', () => {
    expect(editBlocked('index.html', tab(), ['index.html'])).toBe(true);
    expect(editBlocked('网页 练习/页面 一.html', tab(), ['网页 练习'])).toBe(true);
    expect(editBlocked('网页 练习/页面 一.html', undefined, ['网页 练习'])).toBe(true);
  });

  it('other files and look-alike names are not blocked', () => {
    expect(editBlocked('网页 练习 二/页面.html', tab(), ['网页 练习'])).toBe(false);
    expect(editBlocked('index.html', tab(), ['index.html.bak', 'css'])).toBe(false);
  });
});
