import { useEffect, useMemo, useState } from 'react';
import type { ProblemRecord } from '../../shared/problem';
import { explain, undefinedName, type RuleContext } from '../../diagnostics/rules';
import { ProblemCard, type ProblemCardProps } from './ProblemCard';
import { useProjectFiles } from '../editor/useProjectIndex';
import type { ProjectIndex } from '../editor/project-index';
import { isBeginnerCode } from '../../diagnostics/beginner-checks';
import { NULL_ACCESS } from '../../diagnostics/rules/null-element';

const EMPTY: RuleContext = {};

/**
 * The facts the explanation rules use for one problem (S22.4/S22.5): the reported line and, for an undefined name, the
 * names declared in scope there. Read from the open file's editor model and the language service; empty while they
 * are being read, or when the file is not open (the card then explains without did-you-mean names and offers no fix).
 */
export function useRuleContext(record: ProblemRecord, uri: string | undefined): RuleContext {
  const [state, setState] = useState<{ key: string; ctx: RuleContext } | null>(null);
  const name = undefinedName(record)?.name ?? null;
  const key = `${record.id}\n${uri ?? ''}\n${record.lastSeen}`;
  const { file, line, column } = record;
  useEffect(() => {
    if (!uri || !file || !line) return undefined;
    let cancelled = false;
    void import('./rule-context-monaco')
      .then((m) => m.gatherRuleContext(uri, file, line, column, name))
      .then((ctx) => {
        if (!cancelled) setState({ key, ctx });
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [key, uri, file, line, column, name]);
  return state?.key === key ? state.ctx : EMPTY;
}

/** The project's HTML ids and classes (from the project index), kept current; undefined without an index. */
export function useProjectSymbols(
  index: ProjectIndex | null | undefined,
): { readonly htmlIds: readonly string[]; readonly htmlClasses: readonly string[] } | undefined {
  // The index notifies on every change (files, and the ids and classes read from them); the names are read again then.
  const [version, setVersion] = useState(0);
  useEffect(() => (index ? index.subscribe(() => setVersion((n) => n + 1)) : undefined), [index]);
  return useMemo(() => {
    if (!index) return undefined;
    void version;
    const table = index.symbols();
    return { htmlIds: [...table.ids.keys()], htmlClasses: [...table.classes.keys()] };
  }, [index, version]);
}

/**
 * The selected problem's card, explained with the facts of its location. A file that did not load (404) is also
 * compared with the project's files (projectIndex), so the card can name the file the path probably meant.
 */
export function ProblemDetails({
  uriOf,
  projectIndex,
  ...props
}: Omit<ProblemCardProps, 'explanation'> & {
  uriOf: (relPath: string) => string | undefined;
  projectIndex?: ProjectIndex | null | undefined;
}) {
  const { record } = props;
  const located = useRuleContext(record, record.file ? uriOf(record.file) : undefined);
  const beginner = record.source === 'static' && isBeginnerCode(record.code);
  const files = useProjectFiles(record.source === 'resource' || beginner ? projectIndex : null);
  // S55.2: selector rules (15, 22, 23) compare with the project's ids and classes.
  const wantsSymbols = beginner || record.code === 'css-selector-unmatched' || NULL_ACCESS.test(record.originalMessage);
  const symbols = useProjectSymbols(wantsSymbols ? projectIndex : null);
  const ctx = useMemo(
    () => ({ ...located, ...(files ? { projectFiles: files } : {}), ...(symbols ?? {}) }),
    [located, files, symbols],
  );
  const explanation = useMemo(() => explain(record, ctx), [record, ctx]);
  return <ProblemCard {...props} explanation={explanation} />;
}
