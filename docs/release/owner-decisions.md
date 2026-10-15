# Owner decisions waiting on you

These are owner tasks: agents prepare them but never mark them done. To accept a recommendation, reply with its
"say yes" line, or change the values in it. The next agent session records your answer, updates the drafts, and
closes the dependent features.

## H.1: minimum OS versions, test devices, physical Apple Silicon Mac

Draft: [ADR 0003](../decisions/0003-platform-support.md). Recommendation:

- **macOS 13 Ventura+** on Apple Silicon only. This matches Electron 44's own floor.
- **Windows 10 22H2+** x64, plus Windows 11.
- Test devices:
  - your Windows 11 PC (current stable),
  - a clean Windows 10 22H2 x64 PC or VM (minimum),
  - a physical Apple Silicon Mac on the current macOS,
  - a macOS 13 VM on that Mac.

> **Say yes to accept:** "H.1 yes: macOS 13+ arm64, Windows 10 22H2+ x64; I have a physical Apple Silicon Mac
> (model: \_\_\_)."

Unblocks S01.4. This also feeds the install guides and the M8 validation.

## H.2: Apple Developer enrolment and Windows signing route; credentials stored for CI only

Pipeline and checklist: [signing.md](signing.md). Comparison: [ADR 0027](../decisions/0027-code-signing.md).
Recommendation:

- **macOS:** enrol in the Apple Developer Program (individual, US$99 or ¥688 a year). Create a Developer ID
  Application certificate and an App Store Connect API key for notarisation.
- **Windows:**
  - **Azure Artifact Signing** (about US$9.99 a month) if you are an individual in the US or Canada, or have a
    company in the US, Canada, EU or UK.
  - Otherwise, for example as an individual in mainland China: ship the beta **unsigned** first, then buy an **OV
    certificate with CI cloud signing** (roughly US$200–500 a year).
- Store everything only as `release` environment secrets (names in signing.md §1–2).

> **Say yes to accept:** "H.2 yes: Apple individual enrolment + API key; Windows route A (Artifact Signing)." Or:
> "… Windows route B with vendor \_\_\_" or "… Windows unsigned for the beta".

Unblocks S28.2 and S28.3, which are `blocked` now. Then S28.5.

## H.4: adjustable assumptions

PLAN §1 lists these as adjustable. Recommendation: keep all three.

- **Chinese-first UI:** yes. zh-CN is already the default locale and en is complete.
- **Weekly hours:** about 30 productive hours a week, the PLAN estimate. Say if your real number differs; at
  about 10 hours a week the timeline roughly triples (PLAN §10).
- **Windows arm64 out of v1:** yes. No arm64 build and no support claim; revisit after v1 (ADR 0003).

> **Say yes to accept:** "H.4 yes: Chinese-first, ~30 h/week, Windows arm64 out of v1." Or change the hours.
