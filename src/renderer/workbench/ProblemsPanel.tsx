import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useI18n } from '../i18n/I18nProvider';
import type { MessageKey } from '../i18n/index';
import type { ProblemRecord } from '../../shared/problem';
import { explain } from '../../diagnostics/rules';
import { formatMessage } from '../../diagnostics/messages';
import {
  SECTION_ORDER,
  activeIds,
  announcementFor,
  type ProblemsView,
  type SectionId,
} from '../problems/problems-view';
import { CheckIcon, SeverityIcon } from '../problems/problem-icons';
import { ChevronDownIcon, UncheckedIcon } from './icons';

interface ProblemsPanelProps {
  open: boolean;
  onToggle: () => void;
  /** No project: nothing has been checked yet, so the honest state is "not checked" — never "no problems". */
  projectOpen: boolean;
  view: ProblemsView;
  /** Removes runtime problems that did not occur again after the preview refreshed. */
  onClearResolved?: (() => void) | undefined;
  /** Details of the selected problem (S17.2 go to code / original error, S22.4 problem card). */
  renderDetails?: ((record: ProblemRecord) => ReactNode) | undefined;
  /** S22.5: the latest one-click fix, kept above the lists until cleared (the fixed problem may leave the list). */
  fixCard?: ReactNode;
}

const SECTION_LABEL: Record<SectionId, MessageKey> = {
  static: 'problems.section.static',
  runtime: 'problems.section.runtime',
  resource: 'problems.section.resource',
};

const SEVERITY_LABEL: Record<ProblemRecord['severity'], MessageKey> = {
  error: 'problems.severity.error',
  warning: 'problems.severity.warning',
  info: 'problems.severity.info',
};

const fill = (text: string, n: number) => text.replace('{n}', String(n));

/** Polite announcements wait this long, so a burst of new problems is announced once. */
const ANNOUNCE_DELAY_MS = 1000;
const ZERO_WIDTH_SPACE = String.fromCharCode(0x200b);

/**
 * Problems lives in the status strip and expands on request (S30.3, S17.1). New problems never open the panel and
 * never move keyboard focus: the strip's counts change and a polite live region announces them once (PLAN §3: notify
 * without interrupting typing). Static, runtime and resource problems are listed separately (PLAN §9).
 */
export function ProblemsPanel({
  open,
  onToggle,
  projectOpen,
  view,
  onClearResolved,
  renderDetails,
  fixCard,
}: ProblemsPanelProps) {
  const { t, locale } = useI18n();
  const [selected, setSelected] = useState<string | null>(null);
  const announcement = useAnnouncement(view, projectOpen);

  const info = view.total - view.errors - view.warnings;
  const summary = !projectOpen
    ? t('problems.unchecked')
    : view.total === 0
      ? t('problems.none')
      : [
          view.errors ? fill(t('problems.count.errors', view.errors), view.errors) : '',
          view.warnings ? fill(t('problems.count.warnings', view.warnings), view.warnings) : '',
          info ? fill(t('problems.count.info', info), info) : '',
        ]
          .filter(Boolean)
          .join(' · ');

  return (
    <section className="region problems" aria-label={t('region.problems')} data-testid="region-problems">
      <div id="problems-panel" className="panel problems-panel" hidden={!open} data-testid="problems-panel">
        <div className="panel-header">
          <h2 className="region-title">{t('problems.tab')}</h2>
          {projectOpen && view.resolvedCandidates > 0 && onClearResolved && (
            <button
              type="button"
              className="quiet-button"
              data-testid="problems-clear-resolved"
              onClick={onClearResolved}
            >
              {t('problems.clearResolved')}
            </button>
          )}
          <button
            type="button"
            className="icon-button"
            aria-label={t('problems.collapse')}
            title={t('problems.collapse')}
            onClick={onToggle}
          >
            <ChevronDownIcon />
          </button>
        </div>
        {!projectOpen ? (
          <p className="problems-message">
            <UncheckedIcon />
            {t('problems.uncheckedDetail')}
          </p>
        ) : (
          // Focusable: the list scrolls inside a short panel, and keyboard users must be able to scroll it (axe
          // scrollable-region-focusable).
          <div
            className="problems-body"
            data-testid="problems-list"
            role="region"
            aria-label={t('problems.list')}
            tabIndex={0}
          >
            {fixCard}
            {view.total === 0 && view.resolvedCandidates === 0 && (
              <p className="problems-message" data-testid="problems-none">
                <CheckIcon />
                {t('problems.noneDetail')}
              </p>
            )}
            {SECTION_ORDER.map((section) => {
              const records = view.sections[section];
              const headingId = `problems-section-${section}`;
              return (
                <section key={section} className="problems-section" aria-labelledby={headingId} data-section={section}>
                  <h3 className="problems-section-title" id={headingId}>
                    {t(SECTION_LABEL[section])}{' '}
                    <span className="problems-badge" data-testid={`problems-badge-${section}`}>
                      {records.filter((r) => !r.stale).length}
                    </span>
                  </h3>
                  {records.length === 0 ? (
                    <p className="problems-section-empty">{t('problems.sectionEmpty')}</p>
                  ) : (
                    <ul className="problems-items">
                      {records.map((record) => (
                        <ProblemRow
                          key={record.id}
                          record={record}
                          title={formatMessage(locale, explain(record).title)}
                          expanded={selected === record.id}
                          onToggle={() => setSelected((id) => (id === record.id ? null : record.id))}
                          details={selected === record.id && renderDetails ? renderDetails(record) : null}
                        />
                      ))}
                    </ul>
                  )}
                </section>
              );
            })}
          </div>
        )}
      </div>
      <div className="status-strip">
        <button
          type="button"
          className="status-button"
          aria-expanded={open}
          aria-controls="problems-panel"
          title={t('problems.toggle')}
          data-testid="problems-toggle"
          data-errors={view.errors}
          data-warnings={view.warnings}
          onClick={onToggle}
        >
          {!projectOpen ? (
            <UncheckedIcon />
          ) : view.errors ? (
            <SeverityIcon severity="error" />
          ) : view.warnings ? (
            <SeverityIcon severity="warning" />
          ) : view.total ? (
            <SeverityIcon severity="info" />
          ) : (
            <CheckIcon />
          )}
          {t('problems.tab')} · {summary}
        </button>
        <span className="sr-only" role="status" aria-live="polite" data-testid="problems-announcer">
          {announcement}
        </span>
      </div>
    </section>
  );
}

function ProblemRow({
  record,
  title,
  expanded,
  onToggle,
  details,
}: {
  record: ProblemRecord;
  title: string;
  expanded: boolean;
  onToggle: () => void;
  details: ReactNode;
}) {
  const { t } = useI18n();
  const where = record.file
    ? `${record.file}${record.line ? `:${record.line}` : ''}`
    : (record.resource?.requestedPath ?? record.resource?.requestedUrl ?? '');
  const detailsId = `problem-details-${record.id}`;
  return (
    <li
      className={`problem-row severity-${record.severity}${record.stale ? ' stale' : ''}`}
      data-testid="problem-row"
      data-problem-id={record.id}
      data-source={record.source}
      data-code={record.code}
    >
      <button
        type="button"
        className="problem-summary"
        aria-expanded={expanded}
        aria-controls={detailsId}
        data-testid="problem-summary"
        onClick={onToggle}
      >
        <span className="problem-severity">
          <SeverityIcon severity={record.severity} />
          {t(SEVERITY_LABEL[record.severity])}
        </span>
        {where && <span className="problem-where">{where}</span>}
        <span className="problem-title">{title}</span>
        {record.count > 1 && <span className="problem-count">{`×${record.count}`}</span>}
        {record.stale && <span className="problem-stale">{t('problems.stale')}</span>}
      </button>
      {expanded && (
        <div className="problem-details" id={detailsId} data-testid="problem-details">
          {details}
        </div>
      )}
    </li>
  );
}

/**
 * Polite, debounced announcement of news in the list (problems-view.ts announcementFor): compared with what was last
 * announced, once the list has been quiet for a moment — so a burst of problems is announced once, and nothing is lost.
 */
function useAnnouncement(view: ProblemsView, projectOpen: boolean): string {
  const { t } = useI18n();
  const [text, setText] = useState('');
  const announced = useRef<Set<string>>(new Set());
  const latest = useRef(view);
  latest.current = view;
  useEffect(() => {
    if (!projectOpen) {
      announced.current = new Set();
      return undefined;
    }
    const timer = setTimeout(() => {
      const news = announcementFor(announced.current, latest.current);
      announced.current = activeIds(latest.current);
      if (!news) return;
      const message =
        news.kind === 'new' ? fill(t('problems.announce.new', news.count), news.count) : t('problems.announce.cleared');
      // A repeated identical message is still announced: alternate a trailing zero-width space.
      setText((current) => (current === message ? `${message}${ZERO_WIDTH_SPACE}` : message));
    }, ANNOUNCE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [view, projectOpen, t]);
  return text;
}
