import type { ReactNode } from 'react';

/**
 * S47.2: a collapsible group that opens and closes with `grid-template-rows: 0fr <-> 1fr` (motion.css), so nothing is
 * measured and nothing jumps while its content grows (an answer streaming in). Closed, the content is inert and
 * hidden from assistive technology at once; it only stays painted while the rows close (visibility follows the
 * transition). `held` keeps it open whatever `open` says (an answer is still streaming).
 */
export function Collapsible({
  open,
  held = false,
  id,
  className,
  testId,
  children,
}: {
  readonly open: boolean;
  readonly held?: boolean;
  readonly id?: string | undefined;
  readonly className?: string | undefined;
  readonly testId?: string | undefined;
  readonly children: ReactNode;
}) {
  const shown = isShown(open, held);
  return (
    <div
      id={id}
      className={className ? `collapsible ${className}` : 'collapsible'}
      data-open={shown}
      data-testid={testId}
      inert={!shown}
      aria-hidden={shown ? undefined : true}
    >
      <div className="collapsible-inner">{children}</div>
    </div>
  );
}

/** Open while asked to be, or while held open (the AI steps fold during a streaming answer). */
export function isShown(open: boolean, held: boolean): boolean {
  return open || held;
}
