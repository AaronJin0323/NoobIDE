import { useEffect, useMemo, useState } from 'react';
import type { ProblemRecord } from '../../shared/problem';
import { explain, undefinedName, type RuleContext } from '../../diagnostics/rules';
import { ProblemCard, type ProblemCardProps } from './ProblemCard';
import { useProjectFiles } from '../editor/useProjectIndex';
import type { ProjectIndex } from '../editor/project-index';

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
  const files = useProjectFiles(record.source === 'resource' ? projectIndex : null);
  const ctx = useMemo(() => (files ? { ...located, projectFiles: files } : located), [located, files]);
  const explanation = useMemo(() => explain(record, ctx), [record, ctx]);
  return <ProblemCard {...props} explanation={explanation} />;
}
