import { describe, expect, it } from 'vitest';
import { WALKTHROUGH_STEPS } from '../../shared/walkthrough';
import { LOCALES } from '../i18n/index';
import {
  FINAL_TASK_LESSON,
  GLOSSARY,
  STEP_LESSONS,
  filterGlossary,
  glossaryEntry,
  glossaryId,
  type Localized,
} from './lessons';

const complete = (text: Localized) => {
  for (const locale of LOCALES) expect(text[locale]?.trim(), locale).toBeTruthy();
};

describe('walkthrough lessons (resources/lessons/walkthrough.json)', () => {
  it('has a title, text and location in zh-CN and en for every step', () => {
    expect(Object.keys(STEP_LESSONS).sort()).toEqual([...WALKTHROUGH_STEPS].sort());
    for (const step of WALKTHROUGH_STEPS) {
      const lesson = STEP_LESSONS[step];
      complete(lesson.title);
      complete(lesson.body);
      complete(lesson.where);
      expect(lesson.terms.length).toBeGreaterThan(0);
    }
    complete(FINAL_TASK_LESSON.title);
    complete(FINAL_TASK_LESSON.goal);
    complete(FINAL_TASK_LESSON.done);
  });

  it('every term a step links to is in the glossary', () => {
    for (const step of WALKTHROUGH_STEPS) {
      for (const term of STEP_LESSONS[step].terms) expect(glossaryEntry(term), `${step} → ${term}`).toBeDefined();
    }
  });

  it('keeps real file names and standard terms in both languages (PLAN §1)', () => {
    const files = { heading: 'index.html', style: 'style.css', interaction: 'script.js', error: 'script.js' } as const;
    for (const [step, file] of Object.entries(files)) {
      for (const locale of LOCALES) {
        expect(STEP_LESSONS[step as keyof typeof files].body[locale]).toContain(file);
      }
    }
    for (const locale of LOCALES) {
      const meet = STEP_LESSONS.files.body[locale];
      for (const term of ['index.html', 'style.css', 'script.js', 'HTML', 'CSS', 'JavaScript']) {
        expect(meet).toContain(term);
      }
      expect(STEP_LESSONS.heading.body[locale]).toContain('<h1>');
      expect(STEP_LESSONS.style.body[locale]).toMatch(/color[\s\S]*font-size/);
      expect(FINAL_TASK_LESSON.goal[locale]).toContain('<p>');
    }
  });

  it('the final task gives the goal only: no step-by-step instructions', () => {
    for (const locale of LOCALES) {
      // no file to open and no place to click is named: the user works it out
      expect(FINAL_TASK_LESSON.goal[locale]).not.toMatch(/index\.html|style\.css|打开|Open /);
    }
  });
});

describe('terminology glossary (S23.4, resources/lessons/glossary.json)', () => {
  it('has 15 or more unique standard terms, each explained in zh-CN and en', () => {
    expect(GLOSSARY.length).toBeGreaterThanOrEqual(15);
    expect(new Set(GLOSSARY.map((entry) => entry.term)).size).toBe(GLOSSARY.length);
    for (const entry of GLOSSARY) {
      for (const locale of LOCALES) {
        expect(entry[locale].name.trim(), `${entry.term} ${locale}`).toBeTruthy();
        expect(entry[locale].text.trim(), `${entry.term} ${locale}`).toBeTruthy();
      }
    }
  });

  it('keeps the standard term itself: an ASCII term used in tutorials, never translated away', () => {
    for (const entry of GLOSSARY) expect(entry.term).toMatch(/^[A-Za-z][A-Za-z .-]*$/);
    for (const term of ['HTML', 'CSS', 'JavaScript', 'DOM', 'selector', 'property', 'variable', 'function', 'event']) {
      expect(glossaryEntry(term), term).toBeDefined();
    }
  });

  it('filters by the standard term or either language, and gives stable ids', () => {
    expect(filterGlossary('').length).toBe(GLOSSARY.length);
    expect(filterGlossary('选择器').map((e) => e.term)).toContain('selector');
    expect(filterGlossary('SELECTOR').map((e) => e.term)).toContain('selector');
    expect(filterGlossary('zzzz-nothing')).toEqual([]);
    expect(glossaryId('local history')).toBe('glossary-local-history');
    expect(new Set(GLOSSARY.map((e) => glossaryId(e.term))).size).toBe(GLOSSARY.length);
  });
});
