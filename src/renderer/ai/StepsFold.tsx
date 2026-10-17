import { useId, useState, type ReactNode } from 'react';
import type { TurnPart } from './chat-model';
import { Collapsible, isShown } from '../theme/Collapsible';
import { ChevronDownIcon } from '../workbench/icons';

/**
 * S47.2: the steps the AI took (tool calls) fold into one group of an answer. The group opens and closes with the
 * grid-rows collapsible; while the answer is still streaming it is held open (new steps keep arriving and must be
 * seen), and the toggle says so. Once the answer is complete the reader may fold it away.
 */

/** A run of consecutive steps, or any other part, in the order of the answer. */
export type AnswerItem =
  | { readonly kind: 'steps'; readonly start: number; readonly steps: readonly Extract<TurnPart, { kind: 'step' }>[] }
  | { readonly kind: 'part'; readonly index: number; readonly part: Exclude<TurnPart, { kind: 'step' }> };

/** Groups consecutive step parts; every other part keeps its own place and index. */
export function groupAnswer(parts: readonly TurnPart[]): AnswerItem[] {
  const items: AnswerItem[] = [];
  parts.forEach((part, index) => {
    if (part.kind !== 'step') {
      items.push({ kind: 'part', index, part });
      return;
    }
    const last = items.at(-1);
    if (last?.kind === 'steps') items[items.length - 1] = { ...last, steps: [...last.steps, part] };
    else items.push({ kind: 'steps', start: index, steps: [part] });
  });
  return items;
}

export function StepsFold({
  count,
  live,
  label,
  heldLabel,
  children,
}: {
  readonly count: number;
  /** The answer is still streaming: the fold is held open. */
  readonly live: boolean;
  readonly label: string;
  readonly heldLabel: string;
  readonly children: ReactNode;
}) {
  const [open, setOpen] = useState(true);
  const id = useId();
  const shown = isShown(open, live);
  return (
    <div className="ai-steps" data-testid="ai-steps" data-held={live || undefined}>
      <button
        type="button"
        className="ai-steps-toggle"
        aria-expanded={shown}
        aria-controls={id}
        aria-disabled={live || undefined}
        title={live ? heldLabel : undefined}
        data-testid="ai-steps-toggle"
        onClick={() => !live && setOpen((o) => !o)}
      >
        <ChevronDownIcon />
        {label}
        <span className="ai-steps-count">{count}</span>
      </button>
      <Collapsible open={open} held={live} id={id} testId="ai-steps-fold">
        {children}
      </Collapsible>
    </div>
  );
}
