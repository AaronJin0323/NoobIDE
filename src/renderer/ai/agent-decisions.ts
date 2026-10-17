import type { AiApi, AiFileChange, AiProposalDecision } from '../../shared/ipc/ai-contract';
import {
  applyChange,
  failureForAgent,
  undoGroupById,
  type AgentApplyHost,
  type ApplyFailure,
  type UndoTurnResult,
} from './agent-apply';

/**
 * The user's decisions on the agent's proposals (S34.2), per window. The chat panel (S33) keeps the turn's events;
 * this store keeps, per proposal, the state of every change, applies accepted changes one at a time through
 * {@link applyChange} (which records each in the turn's local-history group), reports the decision to the agent once
 * every change is decided, and undoes a turn from that history group — the same undo the History window offers, so
 * it does not depend on this store's memory. Outside React so a re-render or a scrolled-away card never loses a
 * decision.
 */
export type ChangeState = 'pending' | 'applying' | 'applied' | 'failed' | 'rejected';

export interface ChangeView {
  readonly state: ChangeState;
  readonly failure?: ApplyFailure;
}

export interface ProposalRef {
  /** The agent turn's request id: also the id of its local-history group. */
  readonly requestId: string;
  /** Shown with the group in the History window: the user's request. */
  readonly label: string;
  readonly proposalId: string;
  readonly changes: readonly AiFileChange[];
}

export interface ProposalState {
  readonly views: readonly ChangeView[];
  /** The decision was sent to the agent; `reportFailed` when that did not work. */
  readonly reported: boolean;
  readonly reportFailed: boolean;
}

export interface DecisionContext {
  readonly api: AiApi | undefined;
  readonly host: AgentApplyHost | null;
  /** The proposal's turn is still running (an ended turn can no longer take a decision). */
  readonly live: () => boolean;
}

/** The decision for the agent, or null while any change is undecided. */
export function decisionOf(proposal: ProposalRef, views: readonly ChangeView[]): AiProposalDecision | null {
  if (views.length !== proposal.changes.length) return null;
  if (views.some((v) => v.state === 'pending' || v.state === 'applying')) return null;
  return {
    requestId: proposal.requestId,
    proposalId: proposal.proposalId,
    results: views.map((v) =>
      v.state === 'applied'
        ? { accepted: true as const, applied: true }
        : v.state === 'failed'
          ? { accepted: true as const, applied: false, error: v.failure ? failureForAgent(v.failure) : 'failed' }
          : { accepted: false as const },
    ),
  };
}

export class AgentDecisionStore {
  private readonly proposals = new Map<string, ProposalState>();
  /** Turns with at least one applied change in this window (their cards offer undo). */
  private readonly applied = new Set<string>();
  private readonly undone = new Map<string, UndoTurnResult>();
  /** S56.3: proposals whose automatic "before AI changes" checkpoint was taken (once per proposal). */
  private readonly checkpointed = new Set<string>();
  private readonly listeners = new Set<() => void>();
  private working = false;
  private version = 0;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getVersion = (): number => this.version;

  /** A change is being applied or a turn undone: every decision waits. */
  get busy(): boolean {
    return this.working;
  }

  state(proposal: ProposalRef): ProposalState {
    return (
      this.proposals.get(proposal.proposalId) ?? {
        views: proposal.changes.map(() => ({ state: 'pending' })),
        reported: false,
        reportFailed: false,
      }
    );
  }

  undoResult(requestId: string): UndoTurnResult | undefined {
    return this.undone.get(requestId);
  }

  canUndo(requestId: string): boolean {
    // After a partial undo (files changed since), the rest can be tried again.
    const undone = this.undone.get(requestId);
    return this.applied.has(requestId) && (undone === undefined || undone.failures.length > 0);
  }

  async accept(ctx: DecisionContext, proposal: ProposalRef, index: number): Promise<void> {
    await this.exclusive(() => this.applyOne(ctx, proposal, index));
    this.report(ctx, proposal);
  }

  async acceptAll(ctx: DecisionContext, proposal: ProposalRef): Promise<void> {
    await this.exclusive(async () => {
      for (let index = 0; index < proposal.changes.length; index += 1) await this.applyOne(ctx, proposal, index);
    });
    this.report(ctx, proposal);
  }

  reject(ctx: DecisionContext, proposal: ProposalRef, index: number): void {
    if (this.working || !ctx.live() || this.state(proposal).views[index]?.state !== 'pending') return;
    this.setView(proposal, index, { state: 'rejected' });
    this.report(ctx, proposal);
  }

  rejectAll(ctx: DecisionContext, proposal: ProposalRef): void {
    if (this.working || !ctx.live()) return;
    this.state(proposal).views.forEach((view, index) => {
      if (view.state === 'pending') this.setView(proposal, index, { state: 'rejected' });
    });
    this.report(ctx, proposal);
  }

  /**
   * Undoes a turn from its local-history group (from the chat card or the History window). Undefined when another
   * change or undo is running, or there is no project.
   */
  async undo(host: AgentApplyHost | null, requestId: string): Promise<UndoTurnResult | undefined> {
    let result: UndoTurnResult | undefined;
    await this.exclusive(async () => {
      if (!host) return;
      result = await undoGroupById(host, requestId);
      this.undone.set(requestId, result);
      this.changed();
    });
    return result;
  }

  private async applyOne(ctx: DecisionContext, proposal: ProposalRef, index: number): Promise<void> {
    const change = proposal.changes[index];
    if (!change || this.state(proposal).views[index]?.state !== 'pending' || !ctx.live()) return;
    if (!ctx.host) {
      this.setView(proposal, index, { state: 'failed', failure: { code: 'write-failed', detail: 'no-project' } });
      return;
    }
    this.setView(proposal, index, { state: 'applying' });
    if (!this.checkpointed.has(proposal.proposalId)) {
      // S56.3: the whole project is kept once, right before the proposal's first change lands.
      this.checkpointed.add(proposal.proposalId);
      await ctx.host.checkpointBeforeAi?.(proposal.label).catch(() => undefined);
    }
    const result = await applyChange(ctx.host, change, { id: proposal.requestId, label: proposal.label });
    if (result.ok) {
      this.applied.add(proposal.requestId);
      this.setView(proposal, index, { state: 'applied' });
    } else {
      this.setView(proposal, index, { state: 'failed', failure: result.failure });
    }
  }

  private report(ctx: DecisionContext, proposal: ProposalRef): void {
    const current = this.state(proposal);
    const decision = decisionOf(proposal, current.views);
    if (!decision || current.reported) return;
    this.proposals.set(proposal.proposalId, { ...current, reported: true });
    this.changed();
    const failed = () => {
      this.proposals.set(proposal.proposalId, { ...this.state(proposal), reportFailed: true });
      this.changed();
    };
    if (!ctx.api) return failed();
    void ctx.api.resolveProposal(decision).then((result) => {
      if (!result.ok) failed();
    }, failed);
  }

  private setView(proposal: ProposalRef, index: number, view: ChangeView): void {
    const current = this.state(proposal);
    this.proposals.set(proposal.proposalId, {
      ...current,
      views: current.views.map((v, i) => (i === index ? view : v)),
    });
    this.changed();
  }

  private async exclusive(task: () => Promise<void>): Promise<void> {
    if (this.working) return;
    this.working = true;
    this.changed();
    try {
      await task();
    } finally {
      this.working = false;
      this.changed();
    }
  }

  private changed(): void {
    this.version += 1;
    for (const listener of [...this.listeners]) listener();
  }
}
