import { describe, expect, it } from 'vitest';
import { completionContextAt, htmlRegionAt, type CompletionContext } from './completion-context';

type Case = [string, CompletionContext | null];

const id = (prefix: string): CompletionContext => ({ kind: 'id', prefix });
const cls = (prefix: string): CompletionContext => ({ kind: 'class', prefix });
const sel = (prefix: string): CompletionContext => ({ kind: 'selector', prefix });
const cssId = (prefix: string): CompletionContext => ({ kind: 'css-id', prefix });
const path = (prefix: string, accept: 'media' | 'css' | 'js' | 'html' | 'any', js = false): CompletionContext => ({
  kind: 'path',
  prefix,
  accept,
  js,
});

describe('completionContextAt — JavaScript (S43.4)', () => {
  const cases: Case[] = [
    ["document.getElementById('", id('')],
    ['document.getElementById("ti', id('ti')],
    ['document.getElementById(`ti', id('ti')],
    ["document.getElementById( 'ti", id('ti')],
    ["document.querySelector('#ti", id('ti')],
    ["document.querySelectorAll('.ca", cls('ca')],
    ["document.querySelector('", sel('')],
    ["document.querySelector('di", sel('di')],
    ["document.querySelector('.card #ti", id('ti')],
    ["document.querySelector('.card > .it", cls('it')],
    ["document.querySelector('ul li", sel('li')],
    ["document.querySelector('div.ca", cls('ca')],
    ["el.closest('.row", cls('row')],
    ["el.matches('#x", id('x')],
    ["document.getElementsByClassName('a b", cls('b')],
    ["el.classList.add('", cls('')],
    ["el.classList.toggle('act", cls('act')],
    ["el.classList.add('a', 'b", cls('b')],
    ["el.classList.replace('old', 'ne", cls('ne')],
    ["el?.classList.contains('x", cls('x')],
    ["import { greet } from './ut", path('./ut', 'js', true)],
    ["import './side", path('./side', 'js', true)],
    ["export { a } from '../li", path('../li', 'js', true)],
    ["const m = await import('./mo", path('./mo', 'js', true)],
    ["import x from '", path('', 'js', true)],
    // negative cases
    ["console.log('#x", null],
    ["alert('.ca", null],
    ["document.getElementById('a') + ('", null],
    ["// document.getElementById('", null],
    ["/* document.getElementById(' */ x('", null],
    ["/* document.getElementById('", null],
    ["document.getElementById('a', '", null],
    ["document.querySelector('[data-x", null],
    ["document.querySelector('a:ho", null],
    ["el.classList.add('a b", null],
    ["const re = /getElementById\\('/; f('", null],
    ["document.getElementById('x');\nconst s = '", null],
    ['document.querySelector(`#${a', null],
    ["import x from 'https://cdn", null],
    ['document.getElementById(', null],
    ['', null],
  ];
  it.each(cases)('%j', (before, expected) => {
    expect(completionContextAt('javascript', before)).toEqual(expected);
  });

  it('a string earlier on the line is closed and does not confuse the scan', () => {
    expect(completionContextAt('javascript', "const a = 'it''s'; document.getElementById('b")).toEqual(id('b'));
    expect(completionContextAt('javascript', "f('(', ')'); document.getElementById('b")).toEqual(id('b'));
  });
});

describe('completionContextAt — CSS (S43.4)', () => {
  const cases: Case[] = [
    ['.wo', cls('wo')],
    ['.', cls('')],
    ['#he', cssId('he')],
    ['h1 {} .card .ti', cls('ti')],
    ['div.ca', cls('ca')],
    ['@media (max-width: 600px) {\n  .mob', cls('mob')],
    ['@media (max-width: 600px) { .a { } #si', cssId('si')],
    ['.a { background: url(', path('', 'media')],
    ['.a { background: url(img/c', path('img/c', 'media')],
    [".a { background: url('../img/猫 ", path('../img/猫 ', 'media')],
    ['@font-face { src: url("fonts/', path('fonts/', 'media')],
    ["@import '", path('', 'css')],
    ['@import "base', path('base', 'css')],
    ["@import url('the", path('the', 'css')],
    // negative cases
    ['.a { color: #f', null],
    ['.a { margin: .5', null],
    ['.a { margin: .', null],
    ['/* .wo', null],
    ['/* x */ .a { } /* #', null],
    ['@media (min-width: 1.', null],
    ['a[href=".', null],
    ['.a { content: ".', null],
    ['@keyframes k { 0% { } .', null],
    ['h1', null],
    ['.a { background: url(https://x', null],
    ['.a { background: url(/abs', null],
  ];
  it.each(cases)('%j', (before, expected) => {
    expect(completionContextAt('css', before)).toEqual(expected);
  });
});

describe('completionContextAt — HTML (S43.4)', () => {
  const cases: Case[] = [
    ['<div class="', cls('')],
    ['<div class="card bi', cls('bi')],
    ["<div class='a ", cls('')],
    ['<div id="x" class=ca', cls('ca')],
    ['<img src="', path('', 'media')],
    ['<img alt="a > b" src="images/猫 照', path('images/猫 照', 'media')],
    ['<audio src="s', path('s', 'media')],
    ['<video poster="p', path('p', 'media')],
    ['<source src="', path('', 'media')],
    ['<input type="image" src="', path('', 'media')],
    ['<input src="', path('', 'any')],
    ['<link rel="stylesheet" href="st', path('st', 'css')],
    ['<link rel="icon" href="', path('', 'media')],
    ['<script src="js/', path('js/', 'js')],
    ['<a href="ab', path('ab', 'html')],
    ['<iframe src="', path('', 'html')],
    ['<form action="', path('', 'html')],
    ['<div data-x="1" src="', path('', 'any')],
    ['<a href="#to', id('to')],
    ['<label for="na', id('na')],
    ['<p>text</p>\n<a\n  class="x"\n  href="../', path('../', 'html')],
    // script and style regions
    ['<body><script>document.getElementById("t', id('t')],
    ['<script type="module">import a from "./', path('./', 'js', true)],
    ['<style>.a { color: red }\n.b', cls('b')],
    ['<style media="screen">#m', cssId('m')],
    ['<style>.a {}</style><p class="z', cls('z')],
    ['<script>let s = "<div class=\'</script><p class="z', cls('z')],
    // negative cases
    ['<!-- <div class="', null],
    ['<!-- x --><p>.', null],
    ['<div class="a">', null],
    ['<div class="a"> .wo', null],
    ['<a href="https://ex', null],
    ['<a href="/abs', null],
    ['<img src="{{ x', null],
    ['<p id="', null],
    ['<label data-for="', null],
    ['<p for="', null],
    ['<style>.a { color: #f', null],
    ['<script>console.log("#x', null],
    ['<script>// document.getElementById("', null],
    ['plain text "', null],
  ];
  it.each(cases)('%j', (before, expected) => {
    expect(completionContextAt('html', before)).toEqual(expected);
  });

  it('unknown languages answer null', () => {
    expect(completionContextAt('json', '"#a')).toBeNull();
  });
});

describe('htmlRegionAt (S43.4)', () => {
  const doc = '<p>a</p><script>let x = 1;</script><style>.a{}</style><!-- <script> --><p>';
  const at = (marker: string, delta = 0) => htmlRegionAt(doc, doc.indexOf(marker) + delta);
  it.each([
    ['markup before any block', at('a</p>'), 'markup'],
    ['inside script', at('let'), 'script'],
    ['inside the script open tag', at('<script>', 3), 'markup'],
    ['inside style', at('.a{}'), 'style'],
    ['after style', at('<!--'), 'markup'],
    ['a <script> in a comment opens nothing', htmlRegionAt(doc, doc.length), 'markup'],
    ['unclosed script', htmlRegionAt('<script src="a.js"></script><SCRIPT>x', 37), 'script'],
    ['script word without a tag', htmlRegionAt('<scripts>x', 10), 'markup'],
  ])('%s', (_name, got, expected) => {
    expect(got).toBe(expected);
  });
});
