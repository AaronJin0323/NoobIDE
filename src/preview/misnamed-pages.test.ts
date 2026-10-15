import { describe, expect, it } from 'vitest';
import { looksLikeHtml, suggestedPageName } from './misnamed-pages';

describe('misnamed pages (a page whose name does not end in .html)', () => {
  it('recognises the start of an HTML document', () => {
    expect(looksLikeHtml('<!DOCTYPE html>\n<html lang="en">')).toBe(true);
    expect(looksLikeHtml('\uFEFF  \n<!doctype html><title>x</title>')).toBe(true);
    expect(looksLikeHtml('<html>\n<body>')).toBe(true);
    expect(looksLikeHtml('<!-- 我的 主页 -->\n<!DOCTYPE html>')).toBe(true);
    expect(looksLikeHtml('<HTML lang="zh-CN">')).toBe(true);
  });

  it('does not take other text for a page', () => {
    expect(looksLikeHtml('')).toBe(false);
    expect(looksLikeHtml('body { color: red }')).toBe(false);
    expect(looksLikeHtml('<htmlfoo>')).toBe(false);
    expect(looksLikeHtml('<div>a fragment</div>')).toBe(false);
    expect(looksLikeHtml('# README with <html> later')).toBe(false);
  });

  it('suggests a name ending in .html for names without an extension or with a mistyped one', () => {
    expect(suggestedPageName('home')).toBe('home.html');
    expect(suggestedPageName('关于 我们')).toBe('关于 我们.html');
    expect(suggestedPageName('page.hmtl')).toBe('page.html');
    expect(suggestedPageName('page.HTLM')).toBe('page.html');
    expect(suggestedPageName('page.thml')).toBe('page.html');
    expect(suggestedPageName('page.html.txt')).toBe('page.html');
    expect(suggestedPageName('notes.txt')).toBe('notes.html');
  });

  it('leaves files with a real other type alone', () => {
    for (const name of ['app.js', 'style.css', 'README.md', 'data.json', 'logo.svg', 'page.html', 'old.htm']) {
      expect(suggestedPageName(name)).toBeNull();
    }
    expect(suggestedPageName('.hidden')).toBeNull();
  });
});
