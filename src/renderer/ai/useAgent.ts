import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import type { AiApi, AiEvent } from '../../shared/ipc/ai-contract';
import { applyChange, undoTurn, type AgentApplyHost, type UndoStep, type UndoTurnResult } from './agent-apply';
import {
  INITIAL_AGENT_SESSION,
  agentReducer,
  conversationHistory,
  decisionOf,
  type AgentItem,
  type AgentSessionState,
} from './agent-session';

/**
 * The agent conversation of one open project (S34.2), independent of its UI so the S33 chat panel can host it: starts
 * agent requests, follows their events, applies the changes the user accepts through {@link applyChange} (one at a
 * time), reports each proposal's decision to the agent once every change is decided, and undoes a turn's applied
 * changes as a group.
 */
export interface AgentController {
  readonly state: AgentSessionState;
  /** A change is being applied or a turn undone: decisions wait. */
  readonly busy: boolean;
  readonly startError: string | null;
  /** Per turn: what undo did (absent until the user undid it). */
  readonly undone: ReadonlyMap<string, UndoTurnResult>;
  send(prompt: string): Promise<void>;
  stop(): void;
  accept(proposalId: string, index: number): Promise<void>;
  reject(proposalId: string, index: number): void;
  acceptAll(proposalId: string): Promise<void>;
  rejectAll(proposalId: string): void;
  /** Turns with applied changes that can be undone. */
  canUndo(requestId: string): boolean;
  undo(requestId: string): Promise<void>;
}

export function useAgent(options: {
  readonly api: AiApi | undefined;
  readonly host: AgentApplyHost | null;
  readonly locale: 'zh-CN' | 'en';
}): AgentController {
  const { api, host, locale } = options;
  const [state, dispatch] = useReducer(agentReducer, INITIAL_AGENT_SESSION);
  const stateRef = useRef(state);
  stateRef.current = state;
  const hostRef = useRef(host);
  hostRef.current = host;
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [startError, setStartError] = useState<string | null>(null);
  const [undone, setUndone] = useState<ReadonlyMap<string, UndoTurnResult>>(new Map());
  /** Applied changes per turn, in the order they were applied (the undo group). */
  const applied = useRef(new Map<string, UndoStep[]>());
  /** Events that arrived before `request` returned their id. */
  const early = useRef<AiEvent[]>([]);
  const starting = useRef(false);

  useEffect(() => {
    if (!api) return undefined;
    return api.onEvent((event) => {
      if (starting.current && event.requestId !== stateRef.current.running) {
        if (early.current.length < 2000) early.current.push(event);
        return;
      }
      dispatch({ type: 'event', event });
    });
  }, [api]);

  // Stop the running turn when the panel goes away (project closed or switched).
  useEffect(
    () => () => {
      const running = stateRef.current.running;
      if (api && running) void api.cancel({ requestId: running });
    },
    [api],
  );

  // Report a proposal's decision once every change is decided.
  useEffect(() => {
    if (!api) return;
    for (const item of state.items) {
      if (item.kind !== 'proposal' || item.reported) continue;
      const decision = decisionOf(item);
      if (!decision) continue;
      dispatch({ type: 'reported', proposalId: item.proposalId, failed: false });
      void api.resolveProposal(decision).then(
        (result) => {
          if (!result.ok) dispatch({ type: 'reported', proposalId: item.proposalId, failed: true });
        },
        () => dispatch({ type: 'reported', proposalId: item.proposalId, failed: true }),
      );
    }
  }, [api, state.items]);

  const proposal = (proposalId: string) =>
    stateRef.current.items.find(
      (item): item is Extract<AgentItem, { kind: 'proposal' }> =>
        item.kind === 'proposal' && item.proposalId === proposalId,
    );

  const runExclusive = useCallback(async (task: () => Promise<void>) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try {
      await task();
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }, []);

  const applyOne = async (proposalId: string, index: number) => {
    const item = proposal(proposalId);
    const change = item?.changes[index];
    const currentHost = hostRef.current;
    if (!item || !change || item.views[index]?.state !== 'pending' || stateRef.current.running !== item.requestId)
      return;
    if (!currentHost) {
      dispatch({ type: 'change', proposalId, index, view: { state: 'failed', failure: { code: 'write-failed' } } });
      return;
    }
    dispatch({ type: 'change', proposalId, index, view: { state: 'applying' } });
    const result = await applyChange(currentHost, change);
    if (result.ok) {
      const steps = applied.current.get(item.requestId) ?? [];
      steps.push(result.undo);
      applied.current.set(item.requestId, steps);
      dispatch({ type: 'change', proposalId, index, view: { state: 'applied' } });
    } else {
      dispatch({ type: 'change', proposalId, index, view: { state: 'failed', failure: result.failure } });
    }
  };

  const send = useCallback(
    async (prompt: string) => {
      const currentHost = hostRef.current;
      if (!api || !currentHost || stateRef.current.running || prompt.trim() === '') return;
      setStartError(null);
      starting.current = true;
      early.current = [];
      try {
        const result = await api.request({
          kind: 'agent',
          projectId: currentHost.projectId,
          history: conversationHistory(stateRef.current.items),
          prompt,
          context: [],
          locale,
        });
        if (!result.ok) {
          setStartError(result.code);
          return;
        }
        dispatch({ type: 'started', requestId: result.value.requestId, prompt });
        stateRef.current = agentReducer(stateRef.current, {
          type: 'started',
          requestId: result.value.requestId,
          prompt,
        });
        for (const event of early.current)
          if (event.requestId === result.value.requestId) dispatch({ type: 'event', event });
      } finally {
        starting.current = false;
        early.current = [];
      }
    },
    [api, locale],
  );

  return {
    state,
    busy,
    startError,
    undone,
    send,
    stop: () => {
      const running = stateRef.current.running;
      if (api && running) void api.cancel({ requestId: running });
    },
    accept: (proposalId, index) => runExclusive(() => applyOne(proposalId, index)),
    reject: (proposalId, index) => {
      if (busyRef.current || proposal(proposalId)?.views[index]?.state !== 'pending') return;
      dispatch({ type: 'change', proposalId, index, view: { state: 'rejected' } });
    },
    acceptAll: (proposalId) =>
      runExclusive(async () => {
        const item = proposal(proposalId);
        for (let index = 0; index < (item?.changes.length ?? 0); index += 1) await applyOne(proposalId, index);
      }),
    rejectAll: (proposalId) => {
      if (busyRef.current) return;
      proposal(proposalId)?.views.forEach((view, index) => {
        if (view.state === 'pending') dispatch({ type: 'change', proposalId, index, view: { state: 'rejected' } });
      });
    },
    canUndo: (requestId) =>
      (applied.current.get(requestId)?.length ?? 0) > 0 &&
      !undone.has(requestId) &&
      stateRef.current.running !== requestId,
    undo: (requestId) =>
      runExclusive(async () => {
        const steps = applied.current.get(requestId);
        const currentHost = hostRef.current;
        if (!steps || !currentHost || undone.has(requestId)) return;
        const result = await undoTurn(currentHost, steps);
        setUndone((previous) => new Map(previous).set(requestId, result));
      }),
  };
}
