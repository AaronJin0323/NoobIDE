/**
 * Lesson content (PLAN §6 resources/lessons: short walkthroughs and terminology explanations). The texts live in
 * resources/lessons as JSON with a zh-CN and an en version of every string, so they can be edited without touching
 * components; they are bundled into the renderer (offline first). Typed access and the locale fallback are here;
 * lessons.test.ts checks that both locales are complete and that every term a step links to is in the glossary.
 */
import walkthroughJson from '../../../resources/lessons/walkthrough.json';
import glossaryJson from '../../../resources/lessons/glossary.json';
import type { WalkthroughStepId } from '../../shared/walkthrough';
import type { Locale } from '../i18n/index';

export type Localized = Readonly<Record<Locale, string>>;

export interface StepLesson {
  readonly title: Localized;
  readonly body: Localized;
  /** Where on screen the step's anchor is, in words (the highlight is never the only cue). */
  readonly where: Localized;
  /** Glossary terms (standard English terms) the step links to. */
  readonly terms: readonly string[];
}

export interface FinalTaskLesson {
  readonly title: Localized;
  readonly goal: Localized;
  readonly done: Localized;
}

export interface GlossaryEntry {
  /** The standard term, shown verbatim in every locale (PLAN §1: keep standard terminology). */
  readonly term: string;
  readonly 'zh-CN': { readonly name: string; readonly text: string };
  readonly en: { readonly name: string; readonly text: string };
}

export const STEP_LESSONS = walkthroughJson.steps as Readonly<Record<WalkthroughStepId, StepLesson>>;
export const FINAL_TASK_LESSON = walkthroughJson.finalTask as FinalTaskLesson;
export const GLOSSARY = glossaryJson.terms as readonly GlossaryEntry[];

export function localized(text: Localized, locale: Locale): string {
  return text[locale] ?? text['zh-CN'];
}

export function glossaryEntry(term: string): GlossaryEntry | undefined {
  return GLOSSARY.find((entry) => entry.term === term);
}

/** Stable DOM id of a glossary entry (used to scroll to and focus it). */
export function glossaryId(term: string): string {
  return `glossary-${term.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
}

/** Case-insensitive filter over the standard term and both localized names and texts. */
export function filterGlossary(query: string, entries: readonly GlossaryEntry[] = GLOSSARY): GlossaryEntry[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...entries];
  return entries.filter((entry) =>
    [entry.term, entry['zh-CN'].name, entry['zh-CN'].text, entry.en.name, entry.en.text].some((text) =>
      text.toLowerCase().includes(q),
    ),
  );
}
