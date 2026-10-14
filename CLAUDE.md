# CLAUDE.md

@AGENTS.md

## Claude-specific notes

- Start every session with `node harness/session.mjs start` and follow the protocol in AGENTS.md.
- Use the task list for the features of the current session; tick them off as `session.mjs set … done` succeeds.
- For high-stakes features (save pipeline, recovery journal, preview isolation, static server path guard), have a
  separate subagent review the diff against the acceptance criteria and AGENTS.md invariants before marking done.
- When a session ends, the PROGRESS.md entry and commit are mandatory — the next session depends on them.
