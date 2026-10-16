import type { ReactNode } from 'react';

/**
 * S45.5 (HIG Empty states): one centred block — icon, title, one sentence and at most one prominent action — used by
 * the AI panel for "not available", "no key", "switched off", consent, an empty conversation and an empty saved-chats
 * list. The title and sentence carry the state in words; the icon is decorative.
 */
export function AiEmptyState({
  icon,
  title,
  body,
  action,
  role,
  testId,
  state,
  titleId,
}: {
  readonly icon: ReactNode;
  readonly title: ReactNode;
  readonly body?: ReactNode;
  readonly action?: ReactNode;
  readonly role?: 'status' | 'group' | undefined;
  readonly testId?: string | undefined;
  readonly state?: string | undefined;
  readonly titleId?: string | undefined;
}) {
  return (
    <div
      className="empty-state ai-empty-state"
      role={role}
      aria-labelledby={role === 'group' ? titleId : undefined}
      data-testid={testId}
      data-state={state}
    >
      <span className="empty-icon ai-empty-icon" aria-hidden="true">
        {icon}
      </span>
      <p className="empty-title" id={titleId}>
        {title}
      </p>
      {body !== undefined && <p className="empty-detail">{body}</p>}
      {action}
    </div>
  );
}
