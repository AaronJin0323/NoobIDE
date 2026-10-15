# 0025 — AI assistant: scope change, providers, and safety rules

- **Status:** accepted
- **Date:** 2026-10-15

## Context

PLAN §4 excluded "AI chat" from the first release, and PLAN §7 sketched later AI ("Explain selected code", "Explain
this error") with three rules: show the context before sending it, generated changes show a diff and are undoable,
and core features stay offline. On 2026-10-15 the owner asked for NoobIDE to be "intelligent, powered by any AI model
API … providing agent mode, inline code recommendations and all AI functions", and chose:

1. **Providers:** direct APIs with the user's own key — Anthropic (Claude) and OpenAI (GPT/Codex models). No external
   agent CLIs, no OpenAI-compatible endpoints in this phase.
2. **Posture:** on by default, full power once a key is entered (completions, chat, inline edit and agent available
   immediately).
3. **Agent limits:** the agent proposes; the user approves each file change as a diff. No shell commands.

This decision records the owner's scope change (the PLAN §4 exclusion of AI chat is lifted for these features) and the
architecture all AI work follows. Plan: [docs/product/ai-plan.md](../product/ai-plan.md).

## Decision

**Where things run.** All provider calls run in the main process (`src/ai/`), through the official SDKs:
`@anthropic-ai/sdk` for Anthropic and `openai` for OpenAI (pure JS, exact pinned versions). The renderer only talks to
main through the typed contract `src/shared/ipc/ai-contract.ts`; main validates every payload and the sender like the
other channels. The preview page never reaches AI channels.

**Keys.** Entered once in Settings → AI, sent to main, encrypted with Electron `safeStorage` (OS keychain) into the
app-data dir, never returned to a renderer, logged, or written into a project. If `safeStorage` is unavailable the key
is not stored and AI stays off with an explanation.

**Consent and context.** Code leaves the machine only for a project the user has allowed (one-time per project,
revocable, remembered in app data). Chat, explain and agent requests show the context list (files, selection,
problem) before sending. Inline completions send a bounded prefix/suffix of the current file once the project is
allowed.

**Agent.** NoobIDE runs its own agent loop (tool use) with read-only tools (list/read/search project files, current
problems, preview console, refresh preview) and _proposal_ tools (edit/create/rename/delete). The loop stops at a
proposal; the workbench shows diffs; accepted changes are applied through the existing save pipeline (atomic write,
local-history snapshot, journal) and the outcome goes back to the agent. All paths are confined to the project root
with the same checks as `ProjectService`. File contents are treated as data, never as instructions (prompt-injection
rule in the system prompt; the agent cannot approve its own proposals). Each turn has a step and token budget and a
Stop button.

**Models.** User-selectable per purpose (chat, agent, edit, inline) from the provider's model list. Defaults:
Anthropic `claude-opus-5-5` for chat/agent/edit and `claude-haiku-5-5` for inline completions (latency); OpenAI
defaults are chosen from `models.list()` at setup, not hard-coded. Anthropic requests use adaptive thinking,
streaming, prompt caching of the stable system prompt and tool list, and handle `refusal` stop reasons.

**Logs and privacy.** Logs record request id, purpose, provider, model, token counts, duration and error codes only —
never prompts, code, or responses. Conversations are kept in memory (optionally in app data per project, never in the
project folder).

**Offline.** No key, AI switched off, or no network: every non-AI feature is unchanged; AI surfaces explain why they are
unavailable. Tests and CI never call a real provider: a scripted fake provider (`src/ai/fake-provider.ts`, enabled by
`NOOBIDE_AI_FAKE`) backs all unit, integration and e2e tests. An optional live smoke test runs only when a key is
present in the environment.

## Dependencies (S31.1)

Pinned exactly in `package.json` (`dependencies`, bundled into the main-process build by Vite; nothing native):

| Package             | Version   | Transitive runtime packages                                                                                                             |
| ------------------- | --------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `@anthropic-ai/sdk` | `0.134.0` | `json-schema-to-ts` (+ `@babel/runtime`, `ts-algebra`), `standardwebhooks` (+ `@stablelib/base64`, `fast-sha256`), `@opentelemetry/api` |
| `openai`            | `7.34.0`  | none (its peer dependencies `ws`, `zod`, `undici`, AWS/Smithy packages are optional and unused)                                         |

Both are pure JavaScript, so no Electron ABI or per-platform build proof is needed. How they are used:

- Anthropic: `client.beta.messages.stream` (beta endpoint for the `server-side-fallback-2026-07-01` header with
  `fallbacks: "default"`), `thinking: { type: "adaptive" }` with `output_config.effort` per purpose, one
  `cache_control` breakpoint on the stable system prompt (tools render before it) plus a top-level breakpoint for
  chat/agent conversations, `eager_input_streaming: true` on every client tool with schema validation of every
  parsed input (`src/ai/providers/schema.ts`), `stop_reason: "refusal"` handled, typed SDK errors mapped to codes.
- OpenAI: Chat Completions streaming (`stream_options.include_usage`) with function tools; arguments are parsed and
  validated before use; `refusal` deltas and `content_filter` are refusals; typed SDK errors mapped to codes.
- `src/ai/providers/provider.ts` is the only interface the rest of NoobIDE sees; tests use the scripted
  `src/ai/fake-provider.ts` or the real SDK clients with a mocked `fetch` — never the network.
- `package-lock.json` was regenerated with `npm install --package-lock-only` on macOS; regenerate it on the Windows
  dev machine on the next dependency change (AGENTS.md).

## Consequences

- PLAN §4/§7 need an owner edit to match (AI is now in scope; the offline and diff/undo rules stay). Until then this
  record is the authority for AI work.
- New runtime dependencies: `@anthropic-ai/sdk`, `openai` (pure JS). Network access only from main to the two
  provider hosts; the preview proxy is unaffected.
- Cost is the user's (their key). The UI shows token usage per request; there is no NoobIDE account or billing.
- Beginners' learning: answers follow the UI locale and explain; agent and edit results are always shown as diffs with
  plain-language reasons.

## Amendment — S36.1 security review (2026-10-15)

An independent review of all AI code against this decision found no high-severity issue; the fixes below are now
part of the decision.

- **Test switches.** `NOOBIDE_AI_FAKE` / `NOOBIDE_AI_FAKE_AGENT` (scripted provider and the reversible test key
  encryptor) are honoured only when `app.isPackaged` is false (`npm start`, unit/integration tests, the Playwright e2e
  suite, which launches `.vite/build` with the Electron binary). A packaged app ignores them and logs
  `ai-fake-ignored`; there is no test-only override for packaged builds (`aiTestEnv` in `src/main/ai-main.ts`).
- **Egress.** The SDKs read `*_BASE_URL`, `ANTHROPIC_AUTH_TOKEN`, `OPENAI_ORG_ID`/`OPENAI_PROJECT_ID`,
  `*_CUSTOM_HEADERS` and `*_LOG` from the environment. The providers set endpoint, credentials and logging explicitly
  (logging off) and send through `guardedFetch` (`src/ai/providers/egress.ts`): only `https://api.anthropic.com` /
  `https://api.openai.com` are reachable, environment-injected headers are dropped.
- **Consent while running.** Revoking a project's consent, switching AI (or inline completions, or the provider) off,
  and removing a key cancel the requests already running, including agent turns. A chat follow-up (non-empty
  history) in a project needs consent like a request with context; a chat without a project carries no context.
- **Data framing.** Project text in chat context, inline prefix/suffix and edit blocks cannot close its frame
  (`neutralizeData` in `src/ai/prompts.ts`); the agent keeps its per-run nonce frames.
- **Window lifecycle.** A reload (main-frame, cross-document navigation) or renderer crash cancels the page's
  requests, not only closing the window.
- **Bounds.** One chat/agent request carries at most 4,000,000 characters in total (parser); an agent turn's working
  time is the loop's wall-time budget (waiting for the user's decision does not count), with a 2-hour backstop.
- **Live smoke test.** `npm run test:ai-live` (`tests/live/`, `vitest.live.config.ts`) runs the real service and agent
  runner against the real providers only when `NOOBIDE_AI_LIVE_ANTHROPIC_KEY` / `NOOBIDE_AI_LIVE_OPENAI_KEY` are set;
  it is not part of `npm test`, `verify` or CI.
