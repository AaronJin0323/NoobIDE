# AI assistant — plan (S31–S36)

Owner request (2026-10-15): NoobIDE becomes "intelligent, powered by any AI model API … agent mode, inline code
recommendations and all AI functions". Owner choices and the safety rules are in
[decision 0025](../decisions/0025-ai-assistant.md); this page is the build plan. Contract:
[`src/shared/ipc/ai-contract.ts`](../../src/shared/ipc/ai-contract.ts).

## What the beginner gets

| Surface            | What it does                                                                                                     |
| ------------------ | ---------------------------------------------------------------------------------------------------------------- |
| Settings → AI      | Pick Anthropic or OpenAI, paste a key (stored in the OS keychain), test it, pick models, switch AI or inline off |
| Inline completions | Grey "ghost text" while typing in HTML/CSS/JS; Tab accepts, Esc dismisses; word-by-word accept                   |
| AI chat panel      | Ask about the project; context chips (current file, selection, a problem) shown before sending; streaming answer |
| Explain            | "Explain this code" on a selection; "Ask AI" on a problem card (adds file, line, original error)                 |
| Inline edit        | Ctrl/Cmd+I on a selection: "make the button blue" → diff in the editor → Accept / Reject                         |
| Agent mode         | "Add an about page with a nav link" → agent reads files, proposes changes as diffs, user accepts each; Stop      |
| Consent            | First AI use in a project asks once: "Code from this project will be sent to <provider>" (revocable)             |

Everything is zh-CN first + en, keyboard reachable, state as text (never colour only).

## Architecture

```
renderer (React)                         main (Node)                              provider
 ├─ settings/AiSettings.tsx  ──ai:*──▶  src/ai/ai-ipc.ts (sender + payload checks)
 ├─ ai/InlineCompletions.ts  ──────────▶ src/ai/service.ts (requests, cancel, budgets, logging w/o code)
 ├─ ai/ChatPanel.tsx         ◀─ai:event─ src/ai/providers/{anthropic,openai}.ts ──▶ api.anthropic.com
 ├─ ai/InlineEdit.ts                     src/ai/agent/{loop,tools}.ts (project-confined)  api.openai.com
 └─ ai/ProposalReview.tsx (diffs)        src/ai/keys.ts (safeStorage) · src/ai/config-store.ts (app data)
                                         src/ai/fake-provider.ts (tests, NOOBIDE_AI_FAKE)
```

- `src/ai/providers/provider.ts` — one interface over both SDKs: `stream(messages, tools?, options) →
AsyncIterable<ProviderEvent>` (text deltas, tool calls, usage, stop reason incl. refusal), `listModels()`, `test()`.
  Anthropic: `@anthropic-ai/sdk`, streaming, adaptive thinking, `cache_control` on the stable system prompt + tool
  list, `eager_input_streaming` on tools with input validation, refusal handling. OpenAI: `openai` SDK equivalents.
- Agent loop (`src/ai/agent/loop.ts`) is ours (manual tool-use loop): read-only tools run immediately; a proposal tool
  ends the step, emits `proposal`, waits for `resolveProposal`, then continues with the outcome as the tool result.
  Budgets: max steps per turn, max tokens, wall time; Stop cancels the stream and the loop.
- Accepted proposals are applied in the renderer by the Workbench through the existing paths: open models +
  `recordEdit`/savers for open files, `workspace.writeFile` (atomic, history hook) / `createEntry` / `renameEntry` /
  `trashEntry` otherwise. One agent turn = one local-history group so it can be undone together.

## Sessions and order

| Session | Goal                                                                                 | Depends on |
| ------- | ------------------------------------------------------------------------------------ | ---------- |
| S31     | AI foundation: providers, keys, config, consent, service, settings UI, fake provider | S13, S24   |
| S32     | Inline completions                                                                   | S31        |
| S33     | Chat panel + explain code/problem                                                    | S31        |
| S34     | Agent mode with diff approval                                                        | S31, S33   |
| S35     | Inline edit (Ctrl/Cmd+I) and AI fix on the problem card                              | S31, S34   |
| S36     | AI safety/quality gate: security review, live smoke, docs, Gate review               | S31–S35    |

S32, S33 and S34 are built in parallel against the contract; each uses the fake provider until S31 lands.

## Testing

All tests run offline against the fake provider (scripted streams: text, tool calls, proposals, errors, refusals,
slow streams for cancel). E2E covers: key entry → stored (never visible again), consent prompt, ghost text accept,
chat with context chips, agent proposal accept/reject with the file on disk and in local history, Stop, offline
errors explained, AI off → no AI UI. A live smoke test (`npm run test:ai-live`) runs only with
`NOOBIDE_AI_LIVE_ANTHROPIC_KEY` / `NOOBIDE_AI_LIVE_OPENAI_KEY` set; never in CI.

## Risks

- Prompt injection from project files or webpage console → agent proposals always need approval; tool results are
  marked as data; agent cannot reach the network except the provider.
- Cost surprises → usage shown per request, budgets per agent turn, inline debounced and cancelled on typing.
- Beginners over-relying on AI → explain-first answers in the user's locale (owner chose full power; revisit after
  H.6 study).
- Key exposure → main-only, safeStorage, redacted logs, a test that greps logs and renderer state for the key.

## v2 (owner request 2026-10-15, after M9)

The owner chose three follow-ups: **S37** proves M9 on Windows x64 (G9 conditions 2–3), **S38** makes chat and agent
preview-aware (page outline, screenshot, runtime errors), captured from main only so preview isolation is unchanged,
and **S39** keeps chats per project in app data and shows token use with an optional daily budget. Milestone M10
in `harness/features.json`; S07.5 fixes a Windows-only watcher test flake found at the start of that session.
More providers (OpenAI-compatible / CN endpoints) were considered and not chosen for now.

## v3: preview annotations (owner request 2026-10-16, after M10/M11)

**S41** (milestone M12, decision 0030) lets a beginner point at part of the running page — pick an element with the
mouse, choose one from a keyboard list, or draw a region on a frozen screenshot — and attach a note ("make this button
bigger"). Main maps the element to its HTML lines and the CSS rules that style it, keeps annotations per project in
app data, and the chat's agent mode receives them as an "Annotation" chip the user sees before sending. Order: design
(S41.1) → source locator (S41.2) → picking in main (S41.3) → store and IPC (S41.4) → preview strip (S41.5) → AI
context (S41.6) → end-to-end proof (S41.7).
