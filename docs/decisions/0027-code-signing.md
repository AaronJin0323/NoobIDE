# 0027 — Code signing: Developer ID + notarisation on macOS, Azure Artifact Signing on Windows

- **Status:** proposed (the pipeline is built; the Windows route is the owner's choice in H.2)
- **Date:** 2026-10-15
- **Feature:** S28.2, S28.3 (owner task H.2)

## Context

PLAN §5 and §11 require signed, notarised and stapled macOS builds and signed Windows builds before public release.
The credentials belong to the owner, a solo developer who may live in mainland China or abroad. They must live only
in the CI release environment, never in the repository, a log or a developer's shell history. Until they exist,
every build must keep working unsigned. The current unsigned behaviour is described in ADR 0023 (an ad-hoc
re-sign on macOS) and in the install guides (Gatekeeper and SmartScreen steps).

## Options considered

### macOS

There is one real option for distribution outside the Mac App Store. You need an Apple Developer Program
membership (US$99 a year, ¥688 a year in mainland China) and a **Developer ID Application** certificate. You
sign with the hardened runtime and notarise with `notarytool`, and the notarisation ticket is stapled to the
download. Notarisation has two credential routes:

| Route                            | Pros                                                                | Cons                                                   |
| -------------------------------- | ------------------------------------------------------------------- | ------------------------------------------------------ |
| App Store Connect API key (.p8)  | Not tied to a person's Apple ID password; can be revoked on its own | Downloadable only once; needs App Store Connect access |
| Apple ID + app-specific password | Quick to create                                                     | Tied to the owner's Apple ID; must be rotated with it  |

### Windows

| Route                                                                                                      | Cost (approximate, check at purchase)                                                                                                                                          | Eligibility                                                                                                                                                                     | CI fit                                                                                                                                                                                                                                                                                                             | SmartScreen                                                                                         |
| ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------- |
| **A. Azure Artifact Signing** (formerly Trusted Signing) through `signtool` + `Azure.CodeSigning.Dlib.dll` | Basic about US$9.99 a month (5,000 signatures a month; one release signs about 10–30 files). An Azure subscription is required, and billing starts when the account is created | Public Trust is open to **organisations in the US, Canada, EU and UK** and to **individuals in the US and Canada only**. A mainland-China individual is not eligible as of 2026 | Excellent. No hardware; a service principal secret in GitHub; Microsoft timestamp                                                                                                                                                                                                                                  | Builds reputation like OV. Certificates rotate daily, but reputation follows the validated identity |
| **B. CA code-signing certificate** (OV, sometimes EV) through `signtool`                                   | OV roughly US$200–500 a year including the vendor's cloud-signing service. EV costs more and gives no SmartScreen advantage since 2024                                         | Open worldwide, including mainland-China individuals and companies, subject to the CA's identity validation                                                                     | Since June 2023 every new private key must live on a hardware token or an HSM, so an exportable `.pfx` in CI is only possible with an older certificate. CI needs the CA's cloud signing service (for example SSL.com eSigner, DigiCert KeyLocker or Certum SimplySign), and each vendor needs its own client step | Builds reputation over downloads                                                                    |
| C. SignPath Foundation (free for qualifying open-source projects)                                          | Free                                                                                                                                                                           | The project must be open source and accepted                                                                                                                                    | Signs uploaded artifacts after the build. The Squirrel-embedded `noobide.exe` would need a second pass                                                                                                                                                                                                             | As B                                                                                                |
| D. Ship unsigned for public testing                                                                        | Free                                                                                                                                                                           | —                                                                                                                                                                               | Already the default                                                                                                                                                                                                                                                                                                | A "Windows protected your PC" warning; the install guides explain "More info → Run anyway"          |

## Decision

1. **The pipeline is credential-gated, and one code path serves every build.** The rules are in
   `signing.config.ts`, which forge.config.ts uses.
   - No signing variables → an unsigned build, exactly as before.
   - All the variables of one route → a signed build.
   - Only some of a route's variables → an error that names the missing variables. A half-configured release
     must never silently ship unsigned.

   `.github/workflows/release.yml` (tags `v*` and manual dispatch, GitHub environment `release`) does the
   following:
   - Its `Signing status` step logs **ENABLED** or **SKIPPED**. It only ever sees booleans, never secret values.
   - It imports the `.p12` into a temporary keychain with a random password, and writes the `.p8` or `.pfx` to
     `$RUNNER_TEMP`.
   - It runs `npm run make`, then `scripts/verify-signing.mjs`, and finally removes all key material in an
     `always()` step.

   CI on pull requests (`ci.yml`) has no secrets at all, and it stays that way.

2. **macOS:**
   - The packager signs with `osxSign`, using the Developer ID identity from the temporary keychain, the hardened
     runtime, and `resources/entitlements.mac.plist`. That file grants JIT only, because every permission request
     is denied in main.
   - The packager notarises the `.app` with `osxNotarize`. The ad-hoc re-sign from ADR 0023 is skipped when
     Developer ID signing is on.
   - A `postMake` hook then signs, notarises (`notarytool submit --wait`, status must be `Accepted`) and staples
     the **DMG**, because Gatekeeper assesses the download itself.
   - The API key route is preferred; Apple ID is the fallback.
   - Verification runs `spctl -a -vvv -t install <dmg>`. The output must say `accepted`, with
     `source=Notarized Developer ID` and the team ID in the origin. Then `xcrun stapler validate <dmg>` runs.
3. **Windows:**
   - `@electron/windows-sign` signs SHA-256 only and timestamps. The packager uses it for `noobide.exe` and the
     DLLs, and Squirrel uses it for `NoobIDE-Setup.exe` and its stubs. `/tr`, `/td` and `/fd` come from the
     library, never from our parameters, because electron-winstaller's bundled 1.x copy always adds them.
   - Verification runs `signtool verify /pa /v` on Setup.exe and noobide.exe. The output must show success, zero
     errors and a timestamp.
   - **Recommended for this owner:**
     - Use **A (Artifact Signing)** if the owner is a US or Canada resident, or has a company in the US, Canada,
       the EU or the UK. It is the cheapest option, uses no hardware, and the pipeline already supports it end to
       end.
     - If the owner is an individual in mainland China, use **D (unsigned) for the public beta now, then B**: an
       OV certificate from a CA whose cloud signing works in CI. The pipeline supports a `.pfx` today. A
       cloud-HSM vendor needs one extra client-setup step, to be added once the vendor is chosen. Prices and
       eligibility above were checked in October 2026 from public pages and must be re-checked when buying.
4. **No secret values in the repository or logs:**
   - `.gitignore` excludes `*.p12`, `*.pfx`, `*.p8`, `*.cer` and `*.keychain-db`.
   - Failing commands are reported without their argument list (`quietExec`), because Node's "Command failed"
     message would otherwise print notarisation passwords.
   - The workflow never sets `DEBUG`, since `@electron/windows-sign` debug logging prints the signtool command
     line, including a `.pfx` password.

## Consequences (incl. how it is verified on macOS arm64 and Windows x64)

- Automated checks:
  - `tests/integration/signing-config.test.ts` covers the all-or-nothing routes, the options and the entitlements.
    It also checks DMG notarisation with a mocked `codesign`/`notarytool`/`stapler`, and that credentials never
    appear in errors.
  - `tests/integration/verify-signing.test.ts` checks the verification logic against mocked spctl, stapler and
    signtool output.
  - `tests/integration/release-workflow.test.ts` checks the workflow's structure, gating and secret handling. On
    Windows it also runs the real `signtool`: a Microsoft-signed binary passes and an unsigned one fails.
- S28.2 and S28.3 are `blocked` on H.2. They become `done` when a `release.yml` run with the secrets shows
  `verify-signing: … signed and verified` on both jobs. The owner records that run's URL as evidence. S28.5 then
  checks the first launch of the downloaded DMG on a physical Mac.
- Risks to watch on the first signed run:
  - Hardened-runtime regressions in Electron helpers. The entitlements are minimal; add only what a failure
    proves is needed.
  - The Artifact Signing client version pinned in the workflow (`ARTIFACT_SIGNING_CLIENT_VERSION`).
  - The `CodeSigningAccountName` key in `metadata.json`, if Microsoft renames it.
