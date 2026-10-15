import { useEffect, useMemo, useState } from 'react';
import type { ProblemRecord } from '../../shared/problem';
import { explain, undefinedName, type RuleContext } from '../../diagnostics/rules';
import { ProblemCard, type ProblemCardProps } from './ProblemCard';

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

/** The selected problem's card, explained with the facts of its location. */
export function ProblemDetails({
  uriOf,
  ...props
}: Omit<ProblemCardProps, 'explanation'> & { uriOf: (relPath: string) => string | undefined }) {
  const { record } = props;
  const ctx = useRuleContext(record, record.file ? uriOf(record.file) : undefined);
  const explanation = useMemo(() => explain(record, ctx), [record, ctx]);
  return <ProblemCard {...props} explanation={explanation} />;
}
