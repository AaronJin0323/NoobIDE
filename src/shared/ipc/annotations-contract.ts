/**
 * Typed contract for preview annotations (S41, decision 0030): the user points at part of the running page, attaches
 * a note, and main maps it to the project's HTML and CSS. Pure TypeScript: no Electron, Node or DOM imports.
 *
 * Invariants (decision 0030):
 * - Picking uses the DevTools protocol's inspect mode and an isolated world from main; nothing is added to the page
 *   (no preload, no page-world script, no IPC). The page never reaches these channels.
 * - Annotations live in app data per project (`annotations/<projectKey>.json`), never in the project folder.
 * - A picked target stays in main (`pickId`); the workbench saves it by id, so it cannot hand main a forged target.
 * - Page text in a target is untrusted data: shown as text, framed as data for the AI, never logged.
 */
import type { IpcResult } from './contract';

export const ANNOTATION_CHANNELS = {
  list: 'annotations:list',
  pick: 'annotations:pick',
  cancelPick: 'annotations:cancel-pick',
  candidates: 'annotations:candidates',
  regionShot: 'annotations:region-shot',
  resolve: 'annotations:resolve',
  save: 'annotations:save',
  update: 'annotations:update',
  remove: 'annotations:remove',
  highlight: 'annotations:highlight',
  context: 'annotations:context',
} as const;

export const ANNOTATION_LIMITS = {
  perProject: 200,
  noteChars: 2_000,
  tagChars: 40,
  idChars: 120,
  classes: 12,
  classChars: 80,
  textChars: 160,
  selectorChars: 400,
  pathDepth: 64,
  rules: 12,
  ruleSelectorChars: 300,
  candidates: 200,
  candidateLabelChars: 120,
  pagePathChars: 512,
} as const;

/** 1-based nth-of-type among the flattened siblings (html/head/body/tbody skipped), from the top down. */
export interface AnnotationAncestryStep {
  readonly tag: string;
  readonly nth: number;
}

export interface AnnotationRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** A style rule of the page that matches the element: in a project file, or in the n-th `<style>` of the page. */
export interface AnnotationCssRule {
  readonly sheet: { readonly kind: 'file'; readonly path: string } | { readonly kind: 'style'; readonly index: number };
  readonly selector: string;
  /** 1-based, among the sheet's rules with this same selector text. */
  readonly occurrence: number;
}

/** What the user pointed at, as main described it from the isolated world. */
export interface AnnotationTarget {
  readonly kind: 'element' | 'region';
  /** Path of the page inside the project ('' = its index page). */
  readonly pagePath: string;
  readonly tag: string;
  readonly id?: string;
  readonly classes: readonly string[];
  /** The element's first text, collapsed and cut. Untrusted page data. */
  readonly text: string;
  /** A CSS selector that finds the element on the page (for the AI and when the source cannot be found). */
  readonly selector: string;
  /** Child-element indexes from `<html>` down (re-finds the element to show it). */
  readonly path: readonly number[];
  readonly ancestry: readonly AnnotationAncestryStep[];
  /** In CSS pixels of the page's viewport at the time it was picked. */
  readonly rect: AnnotationRect;
  readonly viewport: { readonly width: number; readonly height: number };
  /** 'region' only: the rectangle the user drew (CSS pixels of the viewport). */
  readonly region?: AnnotationRect;
  readonly rules: readonly AnnotationCssRule[];
}

export type AnnotationMatch = 'exact' | 'approximate';

export interface AnnotationLocation {
  /** Project-relative path with '/' separators. */
  readonly relPath: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly match: AnnotationMatch;
}

export interface AnnotationCssLocation extends AnnotationLocation {
  readonly selector: string;
}

/** Where the target is in the source now ('no-file': the page's file could not be read). */
export type AnnotationSourceState = 'found' | 'approximate' | 'not-found' | 'no-file';

export interface AnnotationSource {
  readonly state: AnnotationSourceState;
  readonly html: AnnotationLocation | null;
  readonly css: readonly AnnotationCssLocation[];
}

export interface Annotation {
  readonly id: string;
  readonly note: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly target: AnnotationTarget;
  /** Re-computed from the files on disk when listed. */
  readonly source: AnnotationSource;
}

/** A picked (or resolved) target waiting in main to be saved with a note. */
export interface AnnotationPick {
  readonly pickId: string;
  readonly target: AnnotationTarget;
  readonly source: AnnotationSource;
}

/** One entry of the keyboard list of notable elements. */
export interface AnnotationCandidate {
  readonly path: readonly number[];
  /** `button "发送"`, `h1 "你好"`, `img alt="logo"` — page text, shown as text. */
  readonly label: string;
}

export interface AnnotationCandidates {
  readonly items: readonly AnnotationCandidate[];
  readonly truncated: boolean;
}

/** A frozen picture of the page for drawing a region (PNG data URL) and the viewport it shows. */
export interface AnnotationRegionShot {
  readonly dataUrl: string;
  readonly width: number;
  readonly height: number;
}

/** The text of an Annotation chip for the AI (exactly what is sent) and where it points. */
export interface AnnotationContext {
  readonly id: string;
  readonly label: string;
  readonly text: string;
  readonly relPath?: string;
  readonly startLine?: number;
  readonly endLine?: number;
  /** The annotated ranges, so a proposal inside one can be marked "in the annotated part". */
  readonly ranges: readonly { readonly relPath: string; readonly startLine: number; readonly endLine: number }[];
}

export type AnnotationPickError = 'not-running' | 'not-owner' | 'not-available' | 'cancelled' | 'busy';
export type AnnotationStoreError = 'unknown-project' | 'not-found' | 'too-many' | 'write-failed' | 'expired';

export type AnnotationResolveHow =
  | { readonly kind: 'path'; readonly path: readonly number[] }
  /** Fractions (0..1) of the viewport. */
  | {
      readonly kind: 'region';
      readonly x: number;
      readonly y: number;
      readonly width: number;
      readonly height: number;
    };

export interface AnnotationsApi {
  list(request: { projectId: string }): Promise<IpcResult<readonly Annotation[], AnnotationStoreError>>;
  /** Puts the preview in pick mode; resolves with the picked target, or `cancelled`. */
  pick(request: { projectId: string }): Promise<IpcResult<AnnotationPick, AnnotationPickError>>;
  cancelPick(request: { projectId: string }): Promise<IpcResult<null, never>>;
  candidates(request: { projectId: string }): Promise<IpcResult<AnnotationCandidates, AnnotationPickError>>;
  regionShot(request: { projectId: string }): Promise<IpcResult<AnnotationRegionShot, AnnotationPickError>>;
  resolve(request: {
    projectId: string;
    how: AnnotationResolveHow;
  }): Promise<IpcResult<AnnotationPick, AnnotationPickError>>;
  save(request: {
    projectId: string;
    pickId: string;
    note: string;
  }): Promise<IpcResult<Annotation, AnnotationStoreError>>;
  update(request: {
    projectId: string;
    id: string;
    note: string;
  }): Promise<IpcResult<Annotation, AnnotationStoreError>>;
  remove(request: { projectId: string; id: string }): Promise<IpcResult<null, AnnotationStoreError>>;
  /** Shows the annotation's element on the page for a few seconds (`id: null` clears). */
  highlight(request: {
    projectId: string;
    id: string | null;
  }): Promise<IpcResult<null, AnnotationPickError | AnnotationStoreError>>;
  context(request: {
    projectId: string;
    ids: readonly string[];
    locale: 'zh-CN' | 'en';
  }): Promise<IpcResult<readonly AnnotationContext[], AnnotationStoreError>>;
}
