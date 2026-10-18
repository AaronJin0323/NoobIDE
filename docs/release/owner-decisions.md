# Owner decisions

These are owner tasks: agents prepare them but never mark them done. To accept a recommendation, reply with its
"say yes" line, or change the values in it. The next agent session records your answer, updates the drafts, and
closes the dependent features.

## Answers received 2026-10-18

The owner answered in chat on 2026-10-18. Recorded by S59.1. The H.x tasks stay owner tasks: **you tick H.1 and H.4
yourself** (`node harness/session.mjs set H.1 done --evidence "answered 2026-10-18"`). H.2 stays open: its
enrolment and credentials do not exist yet. Agents never mark a human task done.

| Task                | Answer                                                                                                                                                                                                     | Unblocks / follow-up                                                                                                                                      |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| H.1                 | Accepted as recommended. **macOS 13 Ventura+** on Apple Silicon only. **Windows 10 22H2+ x64**, plus Windows 11. Test devices as recommended below. Physical test Mac: **MacBook Pro M3 Pro, macOS 27.2**. | ADR 0003 accepted, so S01.4 can close. Install guides and release notes state the minimums. `manual-mac` checks (S28.5, M8 validation) run on the M3 Pro. |
| H.2                 | Ship **unsigned on both platforms** for the invite-only beta. No Apple enrolment and no Windows certificate yet. Revisit signing before the public beta.                                                   | ADR 0027 amended. S28.2 and S28.3 stay `blocked` until signing credentials exist. S59.3: the install guides explain the SmartScreen and Gatekeeper steps. |
| H.4 language        | Changed. The UI language **follows the OS language**: Chinese on a Chinese OS, English everywhere else. A saved user choice wins. zh-CN and en must both stay complete.                                    | AGENTS.md and PLAN.md i18n rule changed. S59.2 implements the first-run language choice.                                                                  |
| H.4 hours           | About **30 productive hours a week**, as planned.                                                                                                                                                          | No schedule change.                                                                                                                                       |
| H.4 Windows arm64   | **Out of v1**, as recommended.                                                                                                                                                                             | Recorded in ADR 0003. No arm64 build, no support claim.                                                                                                   |
| Release path        | **Invite-only beta first**: S29 acceptance → G7 → H.7 beta → H.8 go/no-go. Public release only after that.                                                                                                 | Signing must be in place before the public beta (H.8).                                                                                                    |
| AI assistant        | **Ships in the beta.** Its live smoke test S36.1 must pass first.                                                                                                                                          | S36.1 is a gate for the beta build. S59.4 release notes name the assistant and its provider requirement.                                                  |
| First version       | **0.1.0-beta.1**.                                                                                                                                                                                          | S59.4: package version and beta release notes.                                                                                                            |
| Windows memory miss | **Not accepted.** The typical-project working set on Windows (about 710 MB against the ~700 MB budget, S27.3) must be fixed.                                                                               | S59.5 tracks the fix (`docs/perf/memory.md` "Remaining gap" options).                                                                                     |
| S58.5 (nightly e2e) | **Undecided.**                                                                                                                                                                                             | Still open. Ask again later.                                                                                                                              |

The sections below are the original prompts, kept for history. Their "say yes" lines are answered.

## H.1: minimum OS versions, test devices, physical Apple Silicon Mac

**Answered 2026-10-18: yes, with a MacBook Pro M3 Pro on macOS 27.2.** See the table above.

Draft: [ADR 0003](../decisions/0003-platform-support.md) (now accepted). Recommendation:

- **macOS 13 Ventura+** on Apple Silicon only. This matches Electron 44's own floor.
- **Windows 10 22H2+** x64, plus Windows 11.
- Test devices:
  - your Windows 11 PC (current stable),
  - a clean Windows 10 22H2 x64 PC or VM (minimum),
  - a physical Apple Silicon Mac on the current macOS,
  - a macOS 13 VM on that Mac.

> ~~Say yes to accept: "H.1 yes: macOS 13+ arm64, Windows 10 22H2+ x64; I have a physical Apple Silicon Mac
> (model: \_\_\_)."~~ Answered.

Unblocks S01.4. This also feeds the install guides and the M8 validation.

## H.2: Apple Developer enrolment and Windows signing route; credentials stored for CI only

**Answered 2026-10-18: unsigned on both platforms for the invite-only beta.** No enrolment and no certificate yet.
Signing is revisited before the public beta. See the table above.

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

> ~~Say yes to accept: "H.2 yes: Apple individual enrolment + API key; Windows route A (Artifact Signing)." Or:
> "… Windows route B with vendor \_\_\_" or "… Windows unsigned for the beta".~~ Answered: unsigned on both.

S28.2 and S28.3 stay `blocked` until the signing credentials exist. Then S28.5.

## H.4: adjustable assumptions

**Answered 2026-10-18.** The language assumption changed; the other two were kept. See the table above.

PLAN §1 lists these as adjustable. Recommendation was to keep all three.

- **Chinese-first UI:** changed. The UI now follows the OS language (zh\* → zh-CN, otherwise en), and a saved user
  choice wins. Both locales stay complete.
- **Weekly hours:** about 30 productive hours a week, the PLAN estimate. Kept. At about 10 hours a week the
  timeline roughly triples (PLAN §10).
- **Windows arm64 out of v1:** yes. No arm64 build and no support claim; revisit after v1 (ADR 0003).

> ~~Say yes to accept: "H.4 yes: Chinese-first, ~30 h/week, Windows arm64 out of v1." Or change the hours.~~
> Answered: OS language, ~30 h/week, Windows arm64 out of v1.
