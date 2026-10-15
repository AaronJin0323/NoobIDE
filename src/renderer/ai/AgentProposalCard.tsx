import { useMemo, useRef, useSyncExternalStore } from 'react';
import type { AiApi } from '../../shared/ipc/ai-contract';
import { useI18n } from '../i18n/I18nProvider';
import { fill } from '../recovery/format';
import { WarningIcon } from '../workbench/icons';
import type { AgentApplyHost } from './agent-apply';
import type { AgentDecisionStore, DecisionContext, ProposalRef } from './agent-decisions';
import type { ChatTurn } from './chat-model';
import type { AiChatExtensions, ProposalPart } from './chat-extensions';
import { ProposalReview, undoFailureText, type ReviewView } from './ProposalReview';
import './agent.css';

interface AgentProposalCardProps {
  readonly part: ProposalPart;
  readonly turn: ChatTurn;
  readonly store: AgentDecisionStore;
  readonly api: AiApi | undefined;
  readonly host: AgentApplyHost | null;
}

const isLive = (turn: ChatTurn) => (turn.status === 'sending' || turn.status === 'streaming') && !turn.stopping;

/**
 * A proposal inside an agent turn of the chat panel (S33 extension point, S34.2): the review card with diffs, the
 * decision state of every change, and — once the turn has ended — "undo this turn's changes" on its last proposal.
 * Undecided changes of an ended turn expire (nothing is applied).
 */
export function AgentProposalCard({ part, turn, store, api, host }: AgentProposalCardProps) {
  const { t } = useI18n();
  useSyncExternalStore(store.subscribe, store.getVersion);
  const turnRef = useRef(turn);
  turnRef.current = turn;
  const requestId = turn.requestId ?? '';
  const proposal: ProposalRef = useMemo(
    () => ({ requestId, label: turn.prompt, proposalId: part.proposalId, changes: part.changes }),
    [requestId, turn.prompt, part.proposalId, part.changes],
  );
  const ctx: DecisionContext = { api, host, live: () => isLive(turnRef.current) && turnRef.current.requestId !== null };
  const state = store.state(proposal);
  const live = isLive(turn);
  const views: ReviewView[] = state.views.map((v) => (v.state === 'pending' && !live ? { state: 'expired' } : v));
  const lastProposal = [...turn.parts].reverse().find((p) => p.kind === 'proposal');
  const showUndo = !live && lastProposal === part && requestId !== '' && store.canUndo(requestId);
  const undoResult = requestId ? store.undoResult(requestId) : undefined;
  return (
    <div className="agent-card" data-testid="agent-card">
      <ProposalReview
        proposalId={part.proposalId}
        changes={part.changes}
        reason={part.reason}
        views={views}
        busy={store.busy || !live}
        onAccept={(index) => void store.accept(ctx, proposal, index)}
        onReject={(index) => store.reject(ctx, proposal, index)}
        onAcceptAll={() => void store.acceptAll(ctx, proposal)}
        onRejectAll={() => store.rejectAll(ctx, proposal)}
      />
      {state.reportFailed && (
        <p className="inline-alert" role="alert">
          <WarningIcon />
          {t('agent.decisionFailed')}
        </p>
      )}
      {showUndo && (
        <p className="agent-undo">
          <button
            type="button"
            className="quiet-button"
            data-testid="agent-undo"
            disabled={store.busy}
            onClick={() => void store.undo(host, requestId)}
          >
            {t('agent.undo')}
          </button>
          <span className="dialog-hint">{t('agent.undo.hint')}</span>
        </p>
      )}
      {undoResult && lastProposal === part && (
        <p role="status" data-testid="agent-undo-result">
          {undoResult.failures.length === 0
            ? fill(t('agent.undo.done'), { n: undoResult.undone })
            : fill(t('agent.undo.partial'), {
                n: undoResult.undone,
                m: undoResult.failures.length,
                reasons: undoResult.failures
                  .map((f) => (f.step ? `${f.step.relPath}: ` : '') + undoFailureText(t, f.failure))
                  .join(' '),
              })}
        </p>
      )}
    </div>
  );
}

/**
 * The agent's extensions for the chat panel (passed to `useAiChat(…, { extensions })`): agent turns in the composer
 * and the proposal review card.
 */
export function agentChatExtensions(deps: {
  readonly store: AgentDecisionStore;
  readonly api: () => AiApi | undefined;
  readonly host: () => AgentApplyHost | null;
}): AiChatExtensions {
  return {
    agent: true,
    renderProposal: (part, turn) => (
      <AgentProposalCard
        key={part.proposalId}
        part={part}
        turn={turn}
        store={deps.store}
        api={deps.api()}
        host={deps.host()}
      />
    ),
  };
}
