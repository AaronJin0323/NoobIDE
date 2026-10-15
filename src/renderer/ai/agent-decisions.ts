import type { AiApi, AiFileChange, AiProposalDecision } from '../../shared/ipc/ai-contract';
import {
  applyChange,
  failureForAgent,
  undoTurn,
  type AgentApplyHost,
  type ApplyFailure,
  type UndoStep,
  type UndoTurnResult,
} from './agent-apply';

/**
 * The user's decisions on the agent's proposals (S34.2), per window. The chat panel (S33) keeps the turn's events;
 * this store keeps, per proposal, the state of every change, applies accepted changes one at a time through
 * {@link applyChange}, reports the decision to the agent once every change is decided, and remembers each turn's
 * applied changes as one undo group. Outside React so a re-render or a scrolled-away card never loses a decision.
 */
export type ChangeState = 'pending' | 'applying' | 'applied' | 'failed' | 'rejected';

export interface ChangeView {
  readonly state: ChangeState;
  readonly failure?: ApplyFailure;
}

export interface ProposalRef {
  readonly requestId: string;
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
  private readonly applied = new Map<string, UndoStep[]>();
  private readonly undone = new Map<string, UndoTurnResult>();
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
    return (this.applied.get(requestId)?.length ?? 0) > 0 && !this.undone.has(requestId);
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

  async undo(host: AgentApplyHost | null, requestId: string): Promise<void> {
    await this.exclusive(async () => {
      const steps = this.applied.get(requestId);
      if (!host || !steps || this.undone.has(requestId)) return;
      this.undone.set(requestId, await undoTurn(host, steps));
      this.changed();
    });
  }

  private async applyOne(ctx: DecisionContext, proposal: ProposalRef, index: number): Promise<void> {
    const change = proposal.changes[index];
    if (!change || this.state(proposal).views[index]?.state !== 'pending' || !ctx.live()) return;
    if (!ctx.host) {
      this.setView(proposal, index, { state: 'failed', failure: { code: 'write-failed', detail: 'no-project' } });
      return;
    }
    this.setView(proposal, index, { state: 'applying' });
    const result = await applyChange(ctx.host, change);
    if (result.ok) {
      const steps = this.applied.get(proposal.requestId) ?? [];
      steps.push(result.undo);
      this.applied.set(proposal.requestId, steps);
      this.setView(proposal, index, { state: 'applied' });
    } else {
      if (result.undo) {
        const steps = this.applied.get(proposal.requestId) ?? [];
        steps.push(result.undo);
        this.applied.set(proposal.requestId, steps);
      }
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
