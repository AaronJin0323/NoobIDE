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

## Consequences

- PLAN §4/§7 need an owner edit to match (AI is now in scope; the offline and diff/undo rules stay). Until then this
  record is the authority for AI work.
- New runtime dependencies: `@anthropic-ai/sdk`, `openai` (pure JS). Network access only from main to the two
  provider hosts; the preview proxy is unaffected.
- Cost is the user's (their key). The UI shows token usage per request; there is no NoobIDE account or billing.
- Beginners' learning: answers follow the UI locale and explain; agent and edit results are always shown as diffs with
  plain-language reasons.
