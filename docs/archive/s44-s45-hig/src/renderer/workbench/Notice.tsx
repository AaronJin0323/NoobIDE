import type { ReactNode } from 'react';
import { WarningIcon } from './icons';
import './editor-column.css';

/**
 * S45.2: the one banner anatomy every file notice shares (HIG Alerts / Layout): a tone icon, a one-line title, at most
 * one sentence, then the trailing actions with the primary action last. Optional extras (a path, a list, a technical
 * detail) sit under the sentence in quiet text. The tone is carried by the icon's shape and the words, never by colour
 * alone. Purely presentational, so its anatomy is unit tested without the app.
 */
export type NoticeTone = 'info' | 'success' | 'warning' | 'danger';

export interface NoticeProps {
  tone: NoticeTone;
  testId: string;
  role: 'status' | 'alert' | 'note';
  /** One line; cut with an ellipsis when the column is narrow (the full text is its tooltip). */
  title?: ReactNode;
  /** Tooltip of the title, e.g. the full path when the title names only the file. */
  titleHint?: string | undefined;
  /** At most one sentence. */
  body?: ReactNode;
  /** Quiet extras under the sentence: a path, a short list, a technical detail. */
  children?: ReactNode;
  /** Trailing buttons in order, the primary action last. */
  actions?: ReactNode;
  /** App-level notices float bottom-left over the workbench instead of sitting in the editor column. */
  floating?: boolean;
  /** Replaces the tone's icon (e.g. a folder for "reopened your project"). */
  icon?: ReactNode;
  dataState?: string | undefined;
}

export function NoticeToneIcon({ tone }: { tone: NoticeTone }) {
  if (tone === 'warning' || tone === 'danger') return <WarningIcon size={15} />;
  return (
    <svg
      width={15}
      height={15}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <circle cx="8" cy="8" r="6.25" />
      {tone === 'success' ? <path d="M5.4 8.2l1.8 1.8 3.4-3.6" /> : <path d="M8 7.4v3.6M8 5.1v.01" />}
    </svg>
  );
}

export function Notice(props: NoticeProps) {
  const { tone, title, body, children, actions } = props;
  return (
    <div
      className={`notice notice-${tone}${props.floating ? ' app-notice' : ''}`}
      role={props.role}
      data-testid={props.testId}
      data-tone={tone}
      data-state={props.dataState}
    >
      <span className="notice-icon">{props.icon ?? <NoticeToneIcon tone={tone} />}</span>
      <div className="notice-text">
        {title !== undefined && (
          <p className="notice-title" title={props.titleHint ?? (typeof title === 'string' ? title : undefined)}>
            {title}
          </p>
        )}
        {body !== undefined && <p className="notice-body">{body}</p>}
        {children}
      </div>
      {actions && <div className="notice-actions">{actions}</div>}
    </div>
  );
}

/** A technical detail (an error message) behind a disclosure, so the notice itself stays one sentence. */
export function NoticeDetail({ summary, text, testId }: { summary: string; text: string; testId?: string }) {
  return (
    <details className="notice-detail" data-testid={testId}>
      <summary>{summary}</summary>
      <span>{text}</span>
    </details>
  );
}
