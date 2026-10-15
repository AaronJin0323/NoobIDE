import { readFile } from 'node:fs/promises';
import { AI_PURPOSES, type AiModelInfo, type AiProviderId, type AiPurpose } from '../shared/ipc/ai-contract';
import {
  ProviderError,
  toolInputProblem,
  type AiProvider,
  type ProviderErrorCode,
  type ProviderEvent,
  type ProviderFactory,
  type ProviderMessage,
  type ProviderStopReason,
  type ProviderStreamRequest,
  type ProviderToolCall,
} from './providers/provider';

/**
 * Scripted fake provider (S31.1, decision 0025): every unit, integration and e2e test of the AI features runs against
 * it; no test calls a real provider. In the app it replaces both real providers when the environment variable
 * `NOOBIDE_AI_FAKE` names a JSON script file (see main.ts), so Playwright can drive streams, tool calls, refusals,
 * errors and slow streams.
 *
 * Script format (all fields optional):
 *
 * ```json
 * {
 *   "models": [{ "id": "fake-large", "displayName": "Fake Large" }],
 *   "rejectKeys": ["sk-bad"],            // keys that fail test/listModels/stream with 'unauthorized'
 *   "testError": "offline",               // every test/listModels fails with this code
 *   "secureStorage": true,                // false: the app behaves as if the OS keychain were unavailable
 *   "turns": [
 *     { "match": "hello", "purpose": "chat", "repeat": false,
 *       "steps": [ { "type": "text", "text": "Hi " }, { "type": "delay", "ms": 200 },
 *                  { "type": "tool-call", "name": "read_file", "input": { "relPath": "index.html" } },
 *                  { "type": "error", "code": "rate-limited" } ],
 *       "systemMatch": "Simplified Chinese",  // optional: only when the system prompt contains this
 *       "stop": "end",                     // default: 'tool-use' when the turn made tool calls, else 'end'
 *       "usage": { "inputTokens": 10, "outputTokens": 5 } }
 *   ],
 *   "defaultTurn": { "steps": [ { "type": "text", "text": "OK" } ] }
 * }
 * ```
 *
 * `NOOBIDE_AI_FAKE` is a file path, the script itself as inline JSON, or `1` for BUILTIN_FAKE_SCRIPT below; a script file can add
 * `"includeBuiltin": true` to append the built-in turns after its own.
 *
 * A turn is chosen as the first unused one whose `match` occurs in the last user text (or last tool result) and
 * whose `purpose` fits; `repeat: true` turns are never used up. Inline requests send
 * `<prefix>…</prefix><suffix>…</suffix>`, so `"match": "slow</prefix>"` picks a prefix ending in `slow`. Without a match the `defaultTurn` (or a short
 * fixed answer) runs. `delay` steps honour cancellation.
 */
export type FakeStep =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'delay'; readonly ms: number }
  | { readonly type: 'tool-call'; readonly name: string; readonly input: unknown; readonly id?: string }
  | { readonly type: 'error'; readonly code: ProviderErrorCode };

export interface FakeTurn {
  readonly match?: string;
  /** Substring of the request's system prompt (e.g. 'Simplified Chinese' picks zh-CN answers). */
  readonly systemMatch?: string;
  readonly purpose?: AiPurpose;
  readonly repeat?: boolean;
  readonly steps: readonly FakeStep[];
  readonly stop?: ProviderStopReason;
  readonly usage?: { readonly inputTokens: number; readonly outputTokens: number };
}

export interface FakeScript {
  readonly models?: readonly AiModelInfo[];
  readonly rejectKeys?: readonly string[];
  readonly testError?: ProviderErrorCode;
  readonly secureStorage?: boolean;
  /** Append BUILTIN_FAKE_SCRIPT's turns (and its default turn when none is given). */
  readonly includeBuiltin?: boolean;
  readonly turns?: readonly FakeTurn[];
  readonly defaultTurn?: FakeTurn;
}

/** What the fake saw (for assertions): never the key. */
export interface FakeRequestRecord {
  readonly provider: AiProviderId;
  readonly purpose: AiPurpose;
  readonly model: string;
  readonly system: string;
  readonly messages: readonly ProviderMessage[];
  readonly toolNames: readonly string[];
}

const ERROR_CODES: readonly ProviderErrorCode[] = [
  'unauthorized',
  'rate-limited',
  'offline',
  'model-not-found',
  'context-too-large',
  'cancelled',
  'invalid-tool-input',
  'provider-error',
];
const STOPS: readonly ProviderStopReason[] = ['end', 'tool-use', 'max-tokens', 'refusal', 'other'];

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isCode = (v: unknown): v is ProviderErrorCode => ERROR_CODES.includes(v as ProviderErrorCode);

function parseStep(raw: unknown): FakeStep | null {
  if (!isRecord(raw)) return null;
  if (raw.type === 'text' && typeof raw.text === 'string') return { type: 'text', text: raw.text };
  if (raw.type === 'delay' && typeof raw.ms === 'number' && raw.ms >= 0) return { type: 'delay', ms: raw.ms };
  if (raw.type === 'tool-call' && typeof raw.name === 'string') {
    return {
      type: 'tool-call',
      name: raw.name,
      input: raw.input ?? {},
      ...(typeof raw.id === 'string' ? { id: raw.id } : {}),
    };
  }
  if (raw.type === 'error' && isCode(raw.code)) return { type: 'error', code: raw.code };
  return null;
}

function parseTurn(raw: unknown): FakeTurn | null {
  if (!isRecord(raw) || !Array.isArray(raw.steps)) return null;
  const steps = raw.steps.map(parseStep);
  if (steps.some((s) => s === null)) return null;
  const usage =
    isRecord(raw.usage) && typeof raw.usage.inputTokens === 'number' && typeof raw.usage.outputTokens === 'number'
      ? { inputTokens: raw.usage.inputTokens, outputTokens: raw.usage.outputTokens }
      : undefined;
  return {
    steps: steps as FakeStep[],
    ...(typeof raw.match === 'string' ? { match: raw.match } : {}),
    ...(typeof raw.systemMatch === 'string' ? { systemMatch: raw.systemMatch } : {}),
    ...(AI_PURPOSES.includes(raw.purpose as AiPurpose) ? { purpose: raw.purpose as AiPurpose } : {}),
    ...(raw.repeat === true ? { repeat: true } : {}),
    ...(STOPS.includes(raw.stop as ProviderStopReason) ? { stop: raw.stop as ProviderStopReason } : {}),
    ...(usage ? { usage } : {}),
  };
}

/** Validates a script; throws with a short reason when it is malformed (a test bug, never user data). */
export function parseFakeScript(raw: unknown): FakeScript {
  if (!isRecord(raw)) throw new Error('fake AI script must be a JSON object');
  const turns = Array.isArray(raw.turns) ? raw.turns.map(parseTurn) : [];
  if (turns.some((t) => t === null)) throw new Error('fake AI script has a malformed turn');
  const defaultTurn = raw.defaultTurn === undefined ? undefined : parseTurn(raw.defaultTurn);
  if (defaultTurn === null) throw new Error('fake AI script has a malformed defaultTurn');
  const models = Array.isArray(raw.models)
    ? raw.models.filter(
        (m): m is AiModelInfo => isRecord(m) && typeof m.id === 'string' && typeof m.displayName === 'string',
      )
    : undefined;
  return {
    turns: turns as FakeTurn[],
    ...(defaultTurn ? { defaultTurn } : {}),
    ...(models ? { models } : {}),
    ...(Array.isArray(raw.rejectKeys)
      ? { rejectKeys: raw.rejectKeys.filter((k): k is string => typeof k === 'string') }
      : {}),
    ...(isCode(raw.testError) ? { testError: raw.testError } : {}),
    ...(typeof raw.secureStorage === 'boolean' ? { secureStorage: raw.secureStorage } : {}),
    ...(raw.includeBuiltin === true ? { includeBuiltin: true } : {}),
  };
}

/**
 * Built-in scenarios (`NOOBIDE_AI_FAKE=1`), shared by the AI e2e suites (S31–S35):
 * - a prompt containing `[[slow]]` streams a first part, then waits until cancelled (Stop);
 * - `[[offline]]` / `[[rate-limited]]` / `[[unauthorized]]` / `[[refused]]` end with that error (refusal: stop reason);
 * - an `edit` request in generate mode (S42 inline `/ai` prompt) answers `<p>Written by the fake AI.</p>`;
 * - any other `edit` request (S35 inline edit, Fix with AI) answers `<p>Edited by the fake AI.</p>`;
 * - anything else gets a short Markdown answer with an ```html block, in Chinese when the system prompt asks for
 *   Simplified Chinese and in English otherwise, then 'done' with usage.
 */
export const BUILTIN_FAKE_SCRIPT: FakeScript = parseFakeScript({
  turns: [
    {
      match: '[[slow]]',
      repeat: true,
      steps: [
        { type: 'text', text: 'Part one. ' },
        { type: 'delay', ms: 600_000 },
        { type: 'text', text: 'never' },
      ],
    },
    { match: '[[offline]]', repeat: true, steps: [{ type: 'error', code: 'offline' }] },
    { match: '[[rate-limited]]', repeat: true, steps: [{ type: 'error', code: 'rate-limited' }] },
    { match: '[[unauthorized]]', repeat: true, steps: [{ type: 'error', code: 'unauthorized' }] },
    { match: '[[refused]]', repeat: true, steps: [{ type: 'text', text: '…' }], stop: 'refusal' },
    // S42: an inline /ai prompt (generate mode) answers new code that replaces the prompt line.
    {
      purpose: 'edit',
      systemMatch: 'The user typed a request on its own line of their file',
      repeat: true,
      steps: [{ type: 'text', text: '<p>Written by the fake AI.</p>' }],
    },
    // S35: an inline edit / AI fix answer is code that replaces the selected lines (never Markdown).
    { purpose: 'edit', repeat: true, steps: [{ type: 'text', text: '<p>Edited by the fake AI.</p>' }] },
    {
      systemMatch: 'Simplified Chinese',
      repeat: true,
      steps: [
        { type: 'text', text: '这是一个**示例回答**。下面是一段 HTML：\n\n' },
        { type: 'text', text: '```html\n<h1>你好，世界</h1>\n<p>欢迎来到我的网页。</p>\n```\n\n' },
        { type: 'text', text: '把它放进 `<body>` 里就可以看到效果。' },
      ],
      usage: { inputTokens: 120, outputTokens: 48 },
    },
  ],
  defaultTurn: {
    steps: [
      { type: 'text', text: 'This is a **sample answer**. Here is some HTML:\n\n' },
      { type: 'text', text: '```html\n<h1>Hello, world</h1>\n<p>Welcome to my page.</p>\n```\n\n' },
      { type: 'text', text: 'Put it inside `<body>` to see it.' },
    ],
    usage: { inputTokens: 120, outputTokens: 48 },
  },
});

/** Resolves `includeBuiltin`. */
export function withBuiltin(script: FakeScript): FakeScript {
  if (!script.includeBuiltin) return script;
  return {
    ...script,
    turns: [...(script.turns ?? []), ...(BUILTIN_FAKE_SCRIPT.turns ?? [])],
    ...(script.defaultTurn || !BUILTIN_FAKE_SCRIPT.defaultTurn ? {} : { defaultTurn: BUILTIN_FAKE_SCRIPT.defaultTurn }),
  };
}

export async function loadFakeScript(file: string): Promise<FakeScript> {
  return parseFakeScript(JSON.parse(await readFile(file, 'utf8')) as unknown);
}

const DEFAULT_MODELS: readonly AiModelInfo[] = [
  { id: 'fake-large', displayName: 'Fake Large' },
  { id: 'fake-small', displayName: 'Fake Small' },
];

function lastInputText(messages: readonly ProviderMessage[]): string {
  const last = messages[messages.length - 1];
  if (!last) return '';
  if (last.role === 'user') return last.text;
  if (last.role === 'tool') return last.results.map((r) => r.content).join('\n');
  return last.text;
}

function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new ProviderError('cancelled', 'cancelled'));
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new ProviderError('cancelled', 'cancelled'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export interface FakeProviderHub {
  readonly factory: ProviderFactory;
  readonly script: FakeScript;
  /** Requests seen so far, oldest first. */
  readonly requests: readonly FakeRequestRecord[];
}

/** One script shared by every provider the factory creates (turns are used up across providers). */
export function createFakeProviders(script: FakeScript): FakeProviderHub {
  const used = new Set<FakeTurn>();
  const requests: FakeRequestRecord[] = [];
  let callCounter = 0;

  const pickTurn = (purpose: AiPurpose, input: string, system: string): FakeTurn => {
    const turn = (script.turns ?? []).find(
      (t) =>
        (t.repeat || !used.has(t)) &&
        (t.purpose === undefined || t.purpose === purpose) &&
        (t.systemMatch === undefined || system.includes(t.systemMatch)) &&
        (t.match === undefined || input.includes(t.match)),
    );
    if (turn) {
      if (!turn.repeat) used.add(turn);
      return turn;
    }
    return script.defaultTurn ?? { steps: [{ type: 'text', text: 'OK' }] };
  };

  const factory: ProviderFactory = (provider, apiKey) => {
    const rejected = (script.rejectKeys ?? []).includes(apiKey);
    const check = (signal?: AbortSignal) => {
      if (signal?.aborted) throw new ProviderError('cancelled', 'cancelled');
      if (rejected) throw new ProviderError('unauthorized', 'fake 401', 401);
    };
    return {
      id: provider,
      async listModels(signal) {
        check(signal);
        if (script.testError) throw new ProviderError(script.testError, `fake ${script.testError}`);
        return script.models ?? DEFAULT_MODELS;
      },
      async test(signal) {
        check(signal);
        if (script.testError) throw new ProviderError(script.testError, `fake ${script.testError}`);
      },
      stream(request: ProviderStreamRequest): AsyncIterable<ProviderEvent> {
        requests.push({
          provider,
          purpose: request.purpose,
          model: request.model,
          system: request.system,
          messages: request.messages,
          toolNames: (request.tools ?? []).map((t) => t.name),
        });
        return (async function* run(): AsyncGenerator<ProviderEvent> {
          check(request.signal);
          const turn = pickTurn(request.purpose, lastInputText(request.messages), request.system);
          let text = '';
          const calls: ProviderToolCall[] = [];
          for (const step of turn.steps) {
            if (request.signal?.aborted) throw new ProviderError('cancelled', 'cancelled');
            if (step.type === 'text') {
              text += step.text;
              yield { type: 'text', text: step.text };
            } else if (step.type === 'delay') await sleep(step.ms, request.signal);
            else if (step.type === 'error') throw new ProviderError(step.code, `fake ${step.code}`);
            else {
              callCounter += 1;
              calls.push({ id: step.id ?? `fake-call-${callCounter}`, name: step.name, input: step.input });
            }
          }
          const reason: ProviderStopReason = turn.stop ?? (calls.length > 0 ? 'tool-use' : 'end');
          if (reason === 'tool-use') {
            const valid: ProviderToolCall[] = [];
            for (const call of calls) {
              const problem = toolInputProblem(request.tools, call.name, call.input);
              if (problem) yield { type: 'tool-call-invalid', id: call.id, name: call.name, problem };
              else valid.push(call);
            }
            for (const call of valid) yield { type: 'tool-call', call };
          }
          yield {
            type: 'stop',
            reason,
            usage: turn.usage ?? { inputTokens: 10, outputTokens: Math.max(1, Math.ceil(text.length / 4)) },
            assistant: {
              role: 'assistant',
              text,
              ...(calls.length > 0 ? { toolCalls: calls } : {}),
              native: { provider: 'fake', content: null },
            },
          };
        })();
      },
    } satisfies AiProvider;
  };

  return { factory, script, requests };
}
