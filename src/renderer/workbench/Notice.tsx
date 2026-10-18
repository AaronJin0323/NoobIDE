import type { ReactNode } from 'react';
import { DangerCircleIcon, InfoCircleIcon, SuccessCircleIcon, WarningIcon } from './icons';

/**
 * S50.2 — the one notice anatomy (rebuilt from the archived S45.2 Notice, commit a110002; docs/history.md): a tone icon, a
 * one-line title, at most one sentence, the details behind a disclosure, then the trailing actions with at most one
 * primary (last). The tone is carried by the icon's shape, the words and `data-tone`, never by colour alone; only a
 * `danger` notice (something failed) has the danger fill — a report or a confirmation never does.
 *
 * Notices have no timer (plan §5 D2 and §8: no timers unless the owner decides otherwise): they stay until the user
 * dismisses them or the state they describe ends.
 */
export type NoticeTone = 'info' | 'success' | 'warning' | 'danger';

export interface NoticeProps {
  readonly tone: NoticeTone;
  /** `alert` for a warning or a failure that needs the user; `status` for a report or a confirmation. */
  readonly role: 'status' | 'alert';
  readonly testId: string;
  /** One line, cut with an ellipsis when narrow (the full text is its tooltip). */
  readonly title: ReactNode;
  /** Tooltip of the title when it is not plain text. */
  readonly titleHint?: string | undefined;
  /** At most one sentence. */
  readonly body?: ReactNode;
  /** Longer content (a list, a path, a technical detail) behind a disclosure named by `detailsLabel`. */
  readonly details?: ReactNode;
  readonly detailsLabel?: string;
  readonly detailsTestId?: string;
  /** Trailing buttons in order; at most one `primary-button`, and it comes last. */
  readonly actions?: ReactNode;
  readonly dataState?: string | undefined;
  readonly className?: string;
}

export function NoticeToneIcon({ tone }: { tone: NoticeTone }) {
  switch (tone) {
    case 'info':
      return <InfoCircleIcon />;
    case 'success':
      return <SuccessCircleIcon />;
    case 'warning':
      return <WarningIcon size={16} />;
    case 'danger':
      return <DangerCircleIcon />;
  }
}

export function Notice({
  tone,
  role,
  testId,
  title,
  titleHint,
  body,
  details,
  detailsLabel,
  detailsTestId,
  actions,
  dataState,
  className,
}: NoticeProps) {
  return (
    <div
      className={['notice', `notice-${tone}`, className].filter(Boolean).join(' ')}
      role={role}
      data-testid={testId}
      data-tone={tone}
      data-state={dataState}
    >
      <span className="notice-icon">
        <NoticeToneIcon tone={tone} />
      </span>
      <div className="notice-text">
        <p className="notice-title" title={titleHint ?? (typeof title === 'string' ? title : undefined)}>
          {title}
        </p>
        {body !== undefined && <p className="notice-body">{body}</p>}
        {details !== undefined && (
          <details className="notice-detail" data-testid={detailsTestId}>
            <summary>{detailsLabel}</summary>
            <div className="notice-detail-body">{details}</div>
          </details>
        )}
      </div>
      {actions && <div className="notice-actions">{actions}</div>}
    </div>
  );
}
