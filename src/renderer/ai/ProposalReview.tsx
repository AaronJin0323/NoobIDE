import type { Placement } from './annotation-placement';
import { Suspense, lazy, useId } from 'react';
import type { AiFileChange } from '../../shared/ipc/ai-contract';
import { useI18n } from '../i18n/I18nProvider';
import type { MessageKey } from '../i18n/index';
import { fill } from '../recovery/format';
import { diffLines } from '../recovery/line-diff';
import { WarningIcon } from '../workbench/icons';
import type { ApplyFailure } from './agent-apply';
import { saveErrorKey } from '../workbench/file-op-messages';
import type { ChangeView } from './agent-decisions';
import { ProposalStateIcon } from './ai-icons';
import { changedLines, primaryIndex, toneOf, type ProposalState } from './proposal-tone';

/** What a change shows: its decision state, or `expired` when the turn ended before a decision. */
export type ReviewView = ChangeView | { readonly state: 'expired'; readonly failure?: undefined };

// Monaco loads with the first diff, not with the workbench.
const ProposalDiff = lazy(() => import('./ProposalDiff').then((m) => ({ default: m.ProposalDiff })));

export interface ProposalReviewProps {
  readonly proposalId: string;
  readonly changes: readonly AiFileChange[];
  /** The agent's plain-language reason, shown above the diffs. */
  readonly reason: string;
  readonly views: readonly ReviewView[];
  /** True while any change is being applied: every decision button waits. */
  readonly busy: boolean;
  /** S41.6: where each change lies relative to the annotations sent with the turn (absent: no annotations). */
  readonly placement?: (change: AiFileChange) => Placement | null;
  onAccept(index: number): void;
  onReject(index: number): void;
  onAcceptAll(): void;
  onRejectAll(): void;
}

const STATE_KEY: Record<ReviewView['state'], MessageKey> = {
  pending: 'agent.state.pending',
  applying: 'agent.state.applying',
  applied: 'agent.state.applied',
  failed: 'agent.state.failed',
  rejected: 'agent.state.rejected',
  expired: 'agent.state.expired',
};

/**
 * Why a change was not applied, in plain words. A failed write is explained by its cause (no permission, disk
 * full…) like a failed save; the internal error code itself is never shown.
 */
export function failureText(t: (key: MessageKey) => string, failure: ApplyFailure | undefined): string {
  const code = failure?.code ?? 'write-failed';
  if (code === 'write-failed') {
    const reason = failure?.detail ? saveErrorKey(failure.detail) : 'save.error.generic';
    return reason === 'save.error.generic' ? t('agent.failure.write-failed') : t(reason);
  }
  return t(`agent.failure.${code}` as MessageKey);
}

/** Why one step of an undone turn was skipped (S34.2): "changed since" means since the turn, not since the read. */
export function undoFailureText(t: (key: MessageKey) => string, failure: ApplyFailure): string {
  return failure.code === 'changed-since' ? t('agent.undo.changed') : failureText(t, failure);
}

/**
 * Review of one agent proposal (S34.2): the reason, then every change with its diff (Monaco diff editor for edits
 * and new files), its decision state as text, and Accept / Reject per change plus for all. Nothing is applied here:
 * the buttons report the user's choice; the panel applies accepted changes through the save pipeline.
 */
export function ProposalReview(props: ProposalReviewProps) {
  const { proposalId, changes, reason, views, busy } = props;
  const { t } = useI18n();
  const baseId = useId();
  const pending = views.filter((v) => v.state === 'pending').length;
  // S48.8: the card has one primary action — the only pending change's Accept, or Accept all for several.
  const primary = primaryIndex(views);
  return (
    <section
      className="agent-proposal"
      aria-label={t('agent.proposal.title')}
      data-testid="agent-proposal"
      data-proposal={proposalId}
    >
      <h3 className="agent-proposal-title">{t('agent.proposal.title')}</h3>
      {reason && <p className="agent-proposal-reason">{fill(t('agent.proposal.reason'), { reason })}</p>}
      <ol className="agent-changes">
        {changes.map((change, index) => {
          const view = views[index] ?? { state: 'pending' };
          const { tone, icon } = toneOf(view.state);
          return (
            <li
              key={index}
              className="agent-change"
              data-testid="agent-change"
              data-state={view.state}
              data-tone={tone}
              data-path={change.relPath}
            >
              <div className="agent-change-head">
                <span className="agent-change-title" id={`${baseId}-${index}`}>
                  {changeTitle(t, change)}
                </span>
                {props.placement?.(change) && (
                  <span
                    className="agent-change-annotated"
                    data-testid="agent-change-annotated"
                    data-placement={props.placement(change)}
                  >
                    {props.placement(change) === 'outside' && <WarningIcon />}
                    {t(
                      props.placement(change) === 'inside'
                        ? 'agent.change.inAnnotated'
                        : 'agent.change.outsideAnnotated',
                    )}
                  </span>
                )}
                <span className="agent-change-state" role="status" data-testid="agent-change-state" data-tone={tone}>
                  <ProposalStateIcon icon={icon} />
                  {view.state === 'failed'
                    ? fill(t(STATE_KEY.failed), { reason: failureText(t, view.failure) })
                    : t(STATE_KEY[view.state])}
                </span>
              </div>
              <ChangeBody change={change} />
              <ChangeDetails change={change} view={view} />
              {view.state === 'pending' && (
                <div className="agent-change-actions">
                  <button
                    type="button"
                    className={primary === index ? 'primary-button' : 'secondary-button'}
                    data-testid="agent-accept"
                    aria-describedby={`${baseId}-${index}`}
                    disabled={busy}
                    onClick={() => props.onAccept(index)}
                  >
                    {t('agent.change.accept')}
                  </button>
                  <button
                    type="button"
                    className="quiet-button"
                    data-testid="agent-reject"
                    aria-describedby={`${baseId}-${index}`}
                    disabled={busy}
                    onClick={() => props.onReject(index)}
                  >
                    {t('agent.change.reject')}
                  </button>
                </div>
              )}
            </li>
          );
        })}
      </ol>
      {pending > 1 && (
        <div className="agent-proposal-actions">
          <button
            type="button"
            className={primary === 'all' ? 'primary-button' : 'secondary-button'}
            data-testid="agent-accept-all"
            disabled={busy}
            onClick={props.onAcceptAll}
          >
            {t('agent.acceptAll')}
          </button>
          <button
            type="button"
            className="quiet-button"
            data-testid="agent-reject-all"
            disabled={busy}
            onClick={props.onRejectAll}
          >
            {t('agent.rejectAll')}
          </button>
        </div>
      )}
    </section>
  );
}

function changeTitle(t: (key: MessageKey) => string, change: AiFileChange): string {
  switch (change.kind) {
    case 'edit':
      return fill(t('agent.change.edit'), { path: change.relPath });
    case 'create':
      return fill(t('agent.change.create'), { path: change.relPath });
    case 'rename':
      return fill(t('agent.change.rename'), { path: change.relPath, to: change.to });
    case 'delete':
      return fill(t('agent.change.delete'), { path: change.relPath });
  }
}

function ChangeBody({ change }: { change: AiFileChange }) {
  const { t } = useI18n();
  if (change.kind === 'rename') return <p className="dialog-hint">{t('agent.rename.note')}</p>;
  if (change.kind === 'delete') return <p className="dialog-hint">{t('agent.delete.note')}</p>;
  const original = change.kind === 'edit' ? change.before : '';
  return (
    <>
      <Suspense fallback={<p className="dialog-hint">{t('agent.diff.loading')}</p>}>
        <ProposalDiff
          relPath={change.relPath}
          original={original}
          modified={change.after}
          ariaLabel={fill(t('agent.diff.label'), { path: change.relPath })}
        />
      </Suspense>
    </>
  );
}

const RESULT_KEY: Record<ProposalState, MessageKey> = {
  pending: 'agent.result.pending',
  applying: 'agent.result.applying',
  applied: 'agent.result.applied',
  failed: 'agent.result.failed',
  rejected: 'agent.result.rejected',
  expired: 'agent.result.expired',
};

const KIND_KEY: Record<AiFileChange['kind'], MessageKey> = {
  edit: 'agent.kind.edit',
  create: 'agent.kind.create',
  rename: 'agent.kind.rename',
  delete: 'agent.kind.delete',
};

/**
 * S48.8: the change's structured input (file, action, lines) and its result (lines changed, save state), each a
 * native disclosure that starts closed: the card leads with the state and the diff, the facts are one click away.
 */
function ChangeDetails({ change, view }: { change: AiFileChange; view: ReviewView }) {
  const { t } = useI18n();
  const text = change.kind === 'edit' || change.kind === 'create' ? change.after : null;
  const original = change.kind === 'edit' ? change.before : '';
  const range = text === null ? null : changedLines(original, text);
  const where =
    range === null
      ? t('agent.details.wholeFile')
      : range.from === range.to
        ? fill(t('agent.details.line'), { from: range.from })
        : fill(t('agent.details.lines'), { from: range.from, to: range.to });
  const counts = text === null ? null : diffLines(original, text);
  return (
    <div className="agent-change-details">
      <details data-testid="agent-change-input">
        <summary>{t('agent.details.input')}</summary>
        <dl>
          <dt>{t('agent.details.file')}</dt>
          <dd className="agent-change-path">
            {change.kind === 'rename' ? `${change.relPath} → ${change.to}` : change.relPath}
          </dd>
          <dt>{t('agent.details.action')}</dt>
          <dd>{t(KIND_KEY[change.kind])}</dd>
          <dt>{t('agent.details.where')}</dt>
          <dd>{where}</dd>
        </dl>
      </details>
      <details data-testid="agent-change-result">
        <summary>{t('agent.details.result')}</summary>
        <dl>
          {counts && (
            <>
              <dt>{t('agent.details.changed')}</dt>
              <dd data-testid="agent-diff-summary">
                {`${fill(t('agent.diff.added', counts.added), { n: counts.added })} · ${fill(t('agent.diff.removed', counts.removed), { n: counts.removed })}`}
              </dd>
            </>
          )}
          <dt>{t('agent.details.saved')}</dt>
          <dd>
            {view.state === 'failed'
              ? fill(t(RESULT_KEY.failed), { reason: failureText(t, view.failure) })
              : t(RESULT_KEY[view.state])}
          </dd>
        </dl>
      </details>
    </div>
  );
}
