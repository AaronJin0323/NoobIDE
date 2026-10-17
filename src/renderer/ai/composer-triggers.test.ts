import { describe, expect, it } from 'vitest';
import { MAX_MENTION, MAX_PATH, acceptablePath, cleanMention, findTrigger, replaceTrigger } from './composer-triggers';

const at = (text: string) => findTrigger(text, text.length);

describe('composer trigger grammar (S48.4)', () => {
  it('opens the command list on / at the start or after whitespace', () => {
    expect(at('/')).toEqual({ kind: 'command', start: 0, end: 1, query: '' });
    expect(at('/sav')).toEqual({ kind: 'command', start: 0, end: 4, query: 'sav' });
    expect(at('hello /sa')).toMatchObject({ kind: 'command', start: 6, query: 'sa' });
    expect(at('line one\n/pre')).toMatchObject({ kind: 'command', start: 9, query: 'pre' });
    expect(at('你好　/保存')).toMatchObject({ kind: 'command', query: '保存' }); // ideographic space
  });

  it('opens the file list on @ at the start or after whitespace', () => {
    expect(at('@')).toEqual({ kind: 'file', start: 0, end: 1, query: '' });
    expect(at('look at @ind')).toMatchObject({ kind: 'file', start: 8, query: 'ind' });
  });

  it('never opens inside a word (paths, URLs, e-mail addresses)', () => {
    expect(at('a/b')).toBeNull();
    expect(at('see http://x')).toBeNull();
    expect(at('me@example.com')).toBeNull();
    expect(at('plain text')).toBeNull();
    expect(at('')).toBeNull();
  });

  it('closes once the word ends (whitespace after it)', () => {
    expect(at('/save ')).toBeNull();
    expect(at('@index.html ')).toBeNull();
  });

  it('uses the word around the caret, and replaces all of it', () => {
    const text = 'fix @sty please';
    expect(findTrigger(text, 7)).toEqual({ kind: 'file', start: 4, end: 8, query: 'st' });
    expect(findTrigger(text, 3)).toBeNull();
  });

  it('strips trailing Latin and CJK punctuation', () => {
    expect(at('看看 @index.html，')?.query).toBe('index.html');
    expect(at('see @style.css.')?.query).toBe('style.css');
    expect(at('@main.js);')?.query).toBe('main.js');
    expect(at('@图片/猫.png。')?.query).toBe('图片/猫.png');
    expect(at('@page」！')?.query).toBe('page');
    expect(cleanMention('a.html?!')).toBe('a.html');
  });

  it('normalises backslashes to /', () => {
    expect(at('@css\\site.css')?.query).toBe('css/site.css');
    expect(cleanMention('a\\b\\c.js')).toBe('a/b/c.js');
  });

  it('caps mentions at 256 and paths at 1024 characters', () => {
    expect(at(`@${'a'.repeat(MAX_MENTION)}`)?.query).toHaveLength(MAX_MENTION);
    expect(at(`@${'a'.repeat(MAX_MENTION + 1)}`)).toBeNull();
    expect(at(`/${'a'.repeat(MAX_MENTION + 1)}`)).toBeNull();
    expect(acceptablePath('a'.repeat(MAX_PATH))).toBe(true);
    expect(acceptablePath('a'.repeat(MAX_PATH + 1))).toBe(false);
    expect(acceptablePath('')).toBe(false);
  });

  it('replaces the word with the accepted text, or removes it without a double space', () => {
    const text = 'fix @sty please';
    const trigger = findTrigger(text, 8)!;
    expect(replaceTrigger(text, trigger, 'css/style.css')).toEqual({ text: 'fix css/style.css please', caret: 17 });
    expect(replaceTrigger(text, trigger, '')).toEqual({ text: 'fix please', caret: 4 });
    const end = findTrigger('open @in', 8)!;
    expect(replaceTrigger('open @in', end, 'index.html')).toEqual({ text: 'open index.html ', caret: 16 });
    expect(replaceTrigger('/sa', findTrigger('/sa', 3)!, '')).toEqual({ text: '', caret: 0 });
  });
});
