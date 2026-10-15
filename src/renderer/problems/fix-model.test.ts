import { describe, expect, it } from 'vitest';
import { explain } from '../../diagnostics/rules';
import { createProblemRecord, type ProblemInput, type ProblemRecord } from '../../shared/problem';
import {
  canRecheck,
  canUndo,
  fixActionOf,
  nextPhase,
  reportsSameProblem,
  startFix,
  verdict,
  type FixState,
} from './fix-model';

const LINE = 'console.log(userNmae);';
const staticInput: ProblemInput = {
  source: 'static',
  severity: 'error',
  projectId: 'p',
  file: 'script.js',
  line: 3,
  column: 13,
  code: '2552',
  message: "Cannot find name 'userNmae'. Did you mean 'userName'?",
  at: 1,
};
const runtimeInput: ProblemInput = {
  source: 'runtime',
  severity: 'error',
  projectId: 'p',
  preview: { sessionId: 's', generation: 2 },
  file: 'script.js',
  line: 3,
  code: 'ReferenceError',
  message: 'Uncaught ReferenceError: userNmae is not defined',
  at: 1,
};
const staticRecord = createProblemRecord(staticInput, 's1');
const runtimeRecord = createProblemRecord(runtimeInput, 'r1');

const actionFor = (record: ProblemRecord) => {
  const action = fixActionOf(explain(record, { lineText: LINE, declaredNames: [{ name: 'userName' }] }));
  if (!action) throw new Error('expected a fix');
  return action;
};

describe('fix offer (S22.5)', () => {
  it('is the replace-text action of exactly one candidate, replacing exactly the misspelled span', () => {
    const action = actionFor(staticRecord);
    expect(action).toMatchObject({
      from: 'userNmae',
      to: 'userName',
      span: { file: 'script.js', line: 3, column: 13, endColumn: 21 },
    });
  });

  it('is not offered with zero or several candidates, or without the located span', () => {
    expect(fixActionOf(explain(staticRecord, { lineText: LINE, declaredNames: [] }))).toBeNull();
    expect(
      fixActionOf(
        explain(staticRecord, { lineText: LINE, declaredNames: [{ name: 'userName' }, { name: 'userNome' }] }),
      ),
    ).toBeNull();
    expect(fixActionOf(explain(staticRecord, { declaredNames: [{ name: 'userName' }] }))).toBeNull();
    // Not a misspelled-name problem at all.
    expect(fixActionOf(explain({ ...staticRecord, code: '1005', originalMessage: "';' expected." }))).toBeNull();
  });
});

describe('when a fix counts as resolved (S22.5)', () => {
  const saved = (record: ProblemRecord, phase: FixState['phase'] = 'checking'): FixState => ({
    ...startFix(record, actionFor(record)),
    phase,
    version: 7,
  });

  it('a code-check problem: resolved only once the re-check answered that it is no longer reported', () => {
    const fix = saved(staticRecord);
    expect(verdict(fix, null, [])).toBe('checking');
    expect(verdict(fix, true, [])).toBe('still-reported');
    expect(verdict(fix, false, [])).toBe('resolved');
  });

  it('a page problem: also needs a preview reload in which it did not occur again', () => {
    const fix = saved(runtimeRecord);
    expect(fix.generation).toBe(2);
    // Not reloaded yet: the original record is still current.
    expect(verdict(fix, false, [runtimeRecord])).toBe('awaiting-refresh');
    // Reloaded and not seen again: the record is stale.
    expect(verdict(fix, false, [{ ...runtimeRecord, stale: true }])).toBe('resolved');
    // Cleared from the list after the reload.
    expect(verdict(fix, false, [])).toBe('resolved');
    // Reloaded and it happened again (a later page load).
    const again = {
      ...runtimeRecord,
      last: { at: 2, message: runtimeRecord.originalMessage, preview: { sessionId: 's', generation: 3 } },
    };
    expect(verdict(fix, false, [again])).toBe('still-reported');
    // The code check still reports it.
    expect(verdict(fix, true, [{ ...runtimeRecord, stale: true }])).toBe('still-reported');
    // No answer from the code check yet.
    expect(verdict(fix, null, [{ ...runtimeRecord, stale: true }])).toBe('checking');
  });

  it('matches the same misspelled name on the same line of the same file only', () => {
    const fix = saved(runtimeRecord);
    expect(reportsSameProblem(fix, staticRecord)).toBe(true);
    expect(reportsSameProblem(fix, { ...staticRecord, line: 4 })).toBe(false);
    expect(reportsSameProblem(fix, { ...staticRecord, file: 'other.js' })).toBe(false);
    expect(
      reportsSameProblem(fix, { ...staticRecord, originalMessage: "Cannot find name 'total'.", code: '2304' }),
    ).toBe(false);
  });

  it('Undo is offered whenever the fix is in the file, including after a failed save; never before it is applied', () => {
    expect(canUndo({ ...saved(staticRecord), phase: 'save-failed' })).toBe(true);
    expect(canUndo(saved(staticRecord, 'resolved'))).toBe(true);
    expect(canUndo({ ...startFix(staticRecord, actionFor(staticRecord)) })).toBe(false);
    expect(canUndo(saved(staticRecord, 'undone'))).toBe(false);
    expect(canUndo({ ...startFix(staticRecord, actionFor(staticRecord)), phase: 'not-applied' })).toBe(false);
    expect(canRecheck(saved(staticRecord, 'save-failed'))).toBe(false);
    expect(canRecheck(saved(staticRecord, 'still-reported'))).toBe(true);
  });

  it('a fix whose save failed (or that is not applied, or undone) is never judged resolved', () => {
    for (const phase of ['save-failed', 'not-applied', 'applying', 'undoing', 'undone', 'undo-failed'] as const) {
      expect(nextPhase(saved(staticRecord, phase), false, [])).toBe(phase);
    }
    expect(nextPhase(saved(staticRecord, 'checking'), false, [])).toBe('resolved');
    // A resolved fix that is reported again (e.g. undone in the editor and autosaved) is no longer resolved.
    expect(nextPhase(saved(staticRecord, 'resolved'), true, [])).toBe('still-reported');
  });
});
