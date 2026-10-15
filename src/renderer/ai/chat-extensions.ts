/**
 * Extension point of the AI chat panel (S33) for agent turns (S34) and other AI features.
 *
 * The panel already understands every AiEvent of the contract: 'text' is rendered as safe Markdown, 'step' and
 * 'proposal' events are kept in the turn's `parts` in arrival order (chat-model.ts `TurnPart`). What an agent turn
 * needs on top is supplied through `AiChatExtensions`, passed to `useAiChat(…, { extensions })` (Workbench) and from
 * there to `<ChatPanel>`:
 *
 * - `agent: true` shows the "Answer a question / Change the project" switch in the composer. Agent turns are sent with
 *   `requestBuilder` (default: an `AiRequest` of kind 'agent' with the same prompt, history, context and locale).
 * - `renderStep(part, turn)` replaces the default step line ("read index.html").
 * - `renderProposal(part, turn)` renders a proposal card (S34.2: diffs with Accept / Reject). Without it the panel
 *   says that changes cannot be reviewed here and nothing is changed. The renderer owns the decision:
 *   it applies accepted changes through the save pipeline and reports them with `ai.resolveProposal` using
 *   `turn.requestId` and `part.proposalId`; the agent's next events arrive in the same turn.
 * - `requestBuilder` replaces how a draft becomes an `AiRequest` (e.g. extra agent options); return null to refuse.
 *
 * Everything rendered by an extension follows the same rules as the panel: text from i18n, keyboard reachable, state
 * as text, and model output never injected as HTML (use `<Markdown>` from ./Markdown).
 */
import type { ReactNode } from 'react';
import type { ChatTurn, TurnPart } from './chat-model';
import type { RequestBuilder } from './chat-controller';

export type StepPart = Extract<TurnPart, { kind: 'step' }>;
export type ProposalPart = Extract<TurnPart, { kind: 'proposal' }>;

export interface AiChatExtensions {
  /** Offer agent turns in the composer. */
  readonly agent?: boolean;
  readonly renderStep?: (part: StepPart, turn: ChatTurn) => ReactNode;
  readonly renderProposal?: (part: ProposalPart, turn: ChatTurn) => ReactNode;
  readonly requestBuilder?: RequestBuilder;
}

/** Props of the consent question shown before a project's code is sent for the first time. */
export interface AiConsentProps {
  readonly projectId: string;
  /** Display name of the active provider, already translated. */
  readonly providerName: string;
  /** Call after consent was stored (the waiting question is then sent). */
  readonly onAllowed: () => void;
  readonly onDeclined: () => void;
}

/**
 * S31's reusable consent component plugs in here (`useAiChat(…, { consent })`); until it is merged the panel uses
 * `ConsentPlaceholder` (ConsentPlaceholder.tsx), which stores the answer with `ai.setConsent`.
 */
export type AiConsentRenderer = (props: AiConsentProps) => ReactNode;
