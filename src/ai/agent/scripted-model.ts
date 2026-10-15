import type { AgentContentBlock, ModelPort, ModelStopReason, ModelStreamEvent, ModelTurnRequest } from './model-port';
import { ModelPortError, type ModelErrorCode } from './model-port';

/**
 * A scripted {@link ModelPort} (S34.1): plays one scripted turn per model call, offline and deterministic. Used by the
 * agent's unit/integration tests and available to the fake provider (NOOBIDE_AI_FAKE) for e2e scripts.
 */
export interface ScriptedTurn {
  /** Text deltas streamed before the tool calls. */
  readonly text?: readonly string[];
  readonly toolCalls?: readonly { readonly name: string; readonly input: unknown; readonly inputError?: string }[];
  /** Default: 'tool_use' when there are tool calls, else 'end_turn'. */
  readonly stopReason?: ModelStopReason;
  readonly usage?: { readonly inputTokens: number; readonly outputTokens: number };
  /** Waits this long (abortable) before the end event. */
  readonly delayMs?: number;
  /** Never ends by itself: only an abort ends the call. */
  readonly hang?: boolean;
  /** Throws this error code instead of ending. */
  readonly fail?: ModelErrorCode;
  /** Opaque provider blocks to include (must come back unchanged). */
  readonly opaque?: readonly unknown[];
}

export type TurnScript = ScriptedTurn | ((request: ModelTurnRequest, call: number) => ScriptedTurn);

export class ScriptedModel implements ModelPort {
  readonly provider = 'scripted';
  /** Every request, as the loop sent it (messages are snapshotted). */
  readonly requests: ModelTurnRequest[] = [];
  private call = 0;

  constructor(private readonly script: readonly TurnScript[]) {}

  async *streamTurn(request: ModelTurnRequest): AsyncIterable<ModelStreamEvent> {
    this.requests.push({ ...request, messages: structuredClone(request.messages) });
    const index = this.call;
    this.call += 1;
    const entry = this.script[index];
    if (entry === undefined) throw new ModelPortError('provider-error', `script has no turn ${index + 1}`);
    const turn = typeof entry === 'function' ? entry(request, index) : entry;
    for (const text of turn.text ?? []) {
      if (request.signal.aborted) return;
      yield { type: 'text', text };
    }
    if (turn.usage) yield { type: 'usage', ...turn.usage };
    if (turn.hang || turn.delayMs)
      await sleep(turn.hang ? Number.POSITIVE_INFINITY : (turn.delayMs ?? 0), request.signal);
    if (request.signal.aborted) throw new ModelPortError('cancelled', 'aborted');
    if (turn.fail) throw new ModelPortError(turn.fail, `scripted ${turn.fail}`);
    const content: AgentContentBlock[] = [];
    for (const data of turn.opaque ?? []) content.push({ type: 'provider', provider: this.provider, data });
    const text = (turn.text ?? []).join('');
    if (text) content.push({ type: 'text', text });
    (turn.toolCalls ?? []).forEach((c, i) =>
      content.push({
        type: 'tool_use',
        id: `call_${index + 1}_${i + 1}`,
        name: c.name,
        input: c.input,
        ...(c.inputError !== undefined ? { inputError: c.inputError } : {}),
      }),
    );
    const stopReason = turn.stopReason ?? ((turn.toolCalls?.length ?? 0) > 0 ? 'tool_use' : 'end_turn');
    yield { type: 'end', stopReason, content };
  }

  get calls(): number {
    return this.call;
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = Number.isFinite(ms) ? setTimeout(done, ms) : undefined;
    function done() {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener('abort', done);
  });
}

/** The tool_result blocks of the last user message of a request (test helper). */
export function lastToolResults(request: ModelTurnRequest): Extract<AgentContentBlock, { type: 'tool_result' }>[] {
  const last = request.messages[request.messages.length - 1];
  return (last?.content ?? []).filter(
    (b): b is Extract<AgentContentBlock, { type: 'tool_result' }> => b.type === 'tool_result',
  );
}
