/**
 * S48.8: one tone per proposal state (docs/product/ui-ux-improvement-plan.md B8). A pending change is the only one
 * that asks for attention (the prominent border and the single primary action); applying is neutral with a status
 * dot; applied, failed and rejected use the ok / danger / muted soft fills; expired stays quiet. Every tone comes with
 * its own icon shape and a word, so the state never depends on colour (AGENTS.md accessibility). Pure TypeScript.
 */
import type { ReviewView } from './ProposalReview';

export type ProposalState = ReviewView['state'];
export type ProposalTone = 'attention' | 'running' | 'ok' | 'danger' | 'muted' | 'quiet';
export type ProposalIcon = 'pending' | 'dot' | 'check' | 'warning' | 'cross' | 'dashed';

export const PROPOSAL_STATES: readonly ProposalState[] = [
  'pending',
  'applying',
  'applied',
  'failed',
  'rejected',
  'expired',
];

const TONES: Record<ProposalState, { readonly tone: ProposalTone; readonly icon: ProposalIcon }> = {
  pending: { tone: 'attention', icon: 'pending' },
  applying: { tone: 'running', icon: 'dot' },
  applied: { tone: 'ok', icon: 'check' },
  failed: { tone: 'danger', icon: 'warning' },
  rejected: { tone: 'muted', icon: 'cross' },
  expired: { tone: 'quiet', icon: 'dashed' },
};

export function toneOf(state: ProposalState): { readonly tone: ProposalTone; readonly icon: ProposalIcon } {
  return TONES[state];
}

/**
 * Which change's Accept is the card's one primary action: the only pending change, or none when several are pending
 * (then "Accept all" is the primary action) or none is.
 */
export function primaryIndex(views: readonly ReviewView[]): number | 'all' | null {
  const pending = views.flatMap((view, index) => (view.state === 'pending' ? [index] : []));
  if (pending.length === 0) return null;
  return pending.length === 1 ? (pending[0] ?? null) : 'all';
}

/**
 * S48.8: the lines a change touches in the new text (1-based, inclusive), for the change's details; null for a
 * rename or delete (the whole file) and for an edit that changes nothing.
 */
export function changedLines(before: string, after: string): { readonly from: number; readonly to: number } | null {
  const a = before.replace(/\r\n?/g, '\n').split('\n');
  const b = after.replace(/\r\n?/g, '\n').split('\n');
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1;
  if (start === a.length && start === b.length) return null;
  let endA = a.length - 1;
  let endB = b.length - 1;
  while (endA >= start && endB >= start && a[endA] === b[endB]) {
    endA -= 1;
    endB -= 1;
  }
  // Only lines removed: the place where they were, in the new text.
  const to = Math.max(endB, start);
  return { from: Math.min(start, b.length - 1) + 1, to: Math.min(to, b.length - 1) + 1 };
}
