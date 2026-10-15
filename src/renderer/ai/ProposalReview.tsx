import { Suspense, lazy } from 'react';
import type { AiFileChange } from '../../shared/ipc/ai-contract';
import { useI18n } from '../i18n/I18nProvider';
import type { MessageKey } from '../i18n/index';
import { fill } from '../recovery/format';
import { diffLines } from '../recovery/line-diff';
import { WarningIcon } from '../workbench/icons';
import type { ApplyFailure } from './agent-apply';
import type { ChangeView } from './agent-decisions';

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

export function failureText(t: (key: MessageKey) => string, failure: ApplyFailure | undefined): string {
  const code = failure?.code ?? 'write-failed';
  return fill(t(`agent.failure.${code}` as MessageKey), { detail: failure?.detail ?? '?' });
}

/**
 * Review of one agent proposal (S34.2): the reason, then every change with its diff (Monaco diff editor for edits
 * and new files), its decision state as text, and Accept / Reject per change plus for all. Nothing is applied here:
 * the buttons report the user's choice; the panel applies accepted changes through the save pipeline.
 */
export function ProposalReview(props: ProposalReviewProps) {
  const { proposalId, changes, reason, views, busy } = props;
  const { t } = useI18n();
  const pending = views.filter((v) => v.state === 'pending').length;
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
          return (
            <li
              key={index}
              className="agent-change"
              data-testid="agent-change"
              data-state={view.state}
              data-path={change.relPath}
            >
              <div className="agent-change-head">
                <span className="agent-change-title">{changeTitle(t, change)}</span>
                <span className="agent-change-state" role="status" data-testid="agent-change-state">
                  {view.state === 'failed' && <WarningIcon />}
                  {view.state === 'failed'
                    ? fill(t(STATE_KEY.failed), { reason: failureText(t, view.failure) })
                    : t(STATE_KEY[view.state])}
                </span>
              </div>
              <ChangeBody change={change} />
              {view.state === 'pending' && (
                <div className="agent-change-actions">
                  <button
                    type="button"
                    className="primary-button"
                    data-testid="agent-accept"
                    disabled={busy}
                    onClick={() => props.onAccept(index)}
                  >
                    {t('agent.change.accept')}
                  </button>
                  <button
                    type="button"
                    className="quiet-button"
                    data-testid="agent-reject"
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
            className="primary-button"
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
  const counts = diffLines(original, change.after);
  return (
    <>
      <p className="dialog-hint agent-diff-summary" data-testid="agent-diff-summary">
        {`${fill(t('agent.diff.added'), { n: counts.added })} · ${fill(t('agent.diff.removed'), { n: counts.removed })}`}
      </p>
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
