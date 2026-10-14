/**
 * What the Problems panel shows (S17.1): static, runtime and resource problems in separate sections (PLAN §9), the
 * counts for the status strip, and the text announced politely to screen readers when the list changes. Pure.
 */
import type { ProblemRecord, ProblemSeverity } from '../../shared/problem';

export type SectionId = 'static' | 'runtime' | 'resource';
export const SECTION_ORDER: readonly SectionId[] = ['static', 'runtime', 'resource'];

export interface ProblemsView {
  readonly sections: Readonly<Record<SectionId, readonly ProblemRecord[]>>;
  readonly errors: number;
  readonly warnings: number;
  readonly total: number;
  /** Runtime/resource problems that have not occurred again since the preview refreshed. */
  readonly resolvedCandidates: number;
}

/** Console errors are page output at run time: they are listed with the runtime problems. */
export function sectionOf(record: ProblemRecord): SectionId {
  if (record.source === 'static') return 'static';
  if (record.source === 'resource') return 'resource';
  return 'runtime';
}

const SEVERITY_RANK: Record<ProblemSeverity, number> = { error: 0, warning: 1, info: 2 };

/** Merges static and runtime records of the current project into sections; newest runtime problems first. */
export function buildView(
  projectId: string | null,
  staticRecords: readonly ProblemRecord[],
  runtimeRecords: readonly ProblemRecord[],
): ProblemsView {
  const sections: Record<SectionId, ProblemRecord[]> = { static: [], runtime: [], resource: [] };
  if (projectId) {
    for (const r of [...staticRecords, ...runtimeRecords]) {
      if (r.projectId === projectId) sections[sectionOf(r)].push(r);
    }
  }
  sections.static.sort(
    (a, b) =>
      SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
      (a.file ?? '').localeCompare(b.file ?? '') ||
      (a.line ?? 0) - (b.line ?? 0),
  );
  const byRecent = (a: ProblemRecord, b: ProblemRecord) =>
    Number(Boolean(a.stale)) - Number(Boolean(b.stale)) || b.lastSeen - a.lastSeen;
  sections.runtime.sort(byRecent);
  sections.resource.sort(byRecent);
  const all = [...sections.static, ...sections.runtime, ...sections.resource];
  const active = all.filter((r) => !r.stale);
  return {
    sections,
    errors: active.filter((r) => r.severity === 'error').length,
    warnings: active.filter((r) => r.severity === 'warning').length,
    total: active.length,
    resolvedCandidates: all.length - active.length,
  };
}

export type Announcement = { readonly kind: 'new'; readonly count: number } | { readonly kind: 'cleared' } | null;

/**
 * What to announce when the list changes: only news — newly appeared problems, or that none are left. Re-ordered or
 * repeated problems are not news (repeats raise a count, they do not interrupt again).
 */
export function announcementFor(previousIds: ReadonlySet<string>, view: ProblemsView): Announcement {
  const current = SECTION_ORDER.flatMap((s) => view.sections[s]).filter((r) => !r.stale);
  const added = current.filter((r) => !previousIds.has(r.id)).length;
  if (added > 0) return { kind: 'new', count: added };
  if (current.length === 0 && previousIds.size > 0) return { kind: 'cleared' };
  return null;
}

export function activeIds(view: ProblemsView): Set<string> {
  return new Set(
    SECTION_ORDER.flatMap((s) => view.sections[s])
      .filter((r) => !r.stale)
      .map((r) => r.id),
  );
}
