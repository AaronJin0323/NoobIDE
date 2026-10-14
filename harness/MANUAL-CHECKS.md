# Manual checks

Checks that need real hardware (Windows x64, physical Apple Silicon Mac) or a human judgement. Agents add a section
here when they set a feature to `needs_manual_check`. The owner runs the steps, records the result, and then closes
the feature:

```bash
node harness/session.mjs set <id> done --evidence "manual: <platform, OS version, date, result>"
```

## Template

### <feature id> — <title>

- **Platform:** Windows 11 x64 / macOS <version> on Apple Silicon
- **Build:** <commit or installer version>
- **Steps:**
  1. …
- **Expected:** …
- **Result:** _(owner fills in: pass/fail, notes, date)_

## Open checks

_(none yet)_
