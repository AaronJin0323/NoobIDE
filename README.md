# NoobIDE

A beginner-friendly desktop IDE for HTML / CSS / JavaScript, for Apple Silicon macOS and Windows x64.
Status: **pre-alpha — harness and plan in place, implementation starts at S01/S02.**

- Product plan: [PLAN.md](PLAN.md)
- Build roadmap (milestones → sessions → features): [docs/ROADMAP.md](docs/ROADMAP.md)
- How agents (and humans) work in this repo: [AGENTS.md](AGENTS.md)
- Progress log: [harness/PROGRESS.md](harness/PROGRESS.md)

## Getting started (Windows or macOS)

Requires Node.js ≥ 22.12 and Git.

```bash
npm install
npm run session -- start   # where are we, what's next
npm run verify             # all quality gates
```

## Starting a build session with an agent

Open the repo in your agent and say something like:

> Continue the NoobIDE build. Follow AGENTS.md: run the session start, verify, then work through the current
> session's features and close out with PROGRESS.md and a commit.

To steer it, name a session or feature: "Do S03" or "Only S04.1 today".

## Owner checklist

`npm run session -- status` lists open owner tasks (H.x): devices, accounts, user studies and go/no-go calls. When
you finish one: `node harness/session.mjs set H.1 done --owner --evidence "what was decided"`. Manual hardware checks
waiting for you are in [harness/MANUAL-CHECKS.md](harness/MANUAL-CHECKS.md).
