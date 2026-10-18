# Code signing: owner checklist (S28.2, S28.3, owner task H.2)

The pipeline is ready (ADR [0027](../decisions/0027-code-signing.md)). Only the credentials are missing. This page
lists exactly what to create, where to store it, and how to prove that it works. Until you finish it, every build
stays unsigned and nothing fails.

**Owner decision 2026-10-18 (H.2):** the invite-only beta ships unsigned on both platforms. Nothing on this page is
needed for the beta. Come back to it before the public beta (H.8). See the amendment in ADR 0027 and
[owner-decisions.md](owner-decisions.md).

**Ground rules**

- Secrets go only into the GitHub environment `release`. Never put them in the repository, an issue, a chat, or a
  file inside the project folder.
- Keep the originals (`.p12`, `.p8`, passwords) in your password manager. GitHub secrets cannot be read back.
- Never add a `DEBUG` variable to the release workflow. Debug output of the signing libraries prints signtool
  command lines.

## 0. Create the GitHub environment (once)

1. Go to the repository → **Settings → Environments → New environment** and name it `release` (exact name).
2. Recommended: **Required reviewers** = you. Each release run then waits for your click before it can use the
   secrets.
3. Under **Deployment branches and tags**, choose **Selected branches and tags** and add the branch `main` and
   the tag pattern `v*`.
4. Add every secret below under that environment's **Environment secrets**, not under repository secrets.

To turn a file into a base64 secret value:

- macOS: `base64 -i FILE | pbcopy`
- Windows PowerShell: `[Convert]::ToBase64String([IO.File]::ReadAllBytes("FILE")) | Set-Clipboard`

## 1. macOS: Developer ID signing and notarisation (S28.2)

1. **Enrol** in the Apple Developer Program at <https://developer.apple.com/programs/enroll/>.
   - Individual membership costs US$99 a year (¥688 a year in mainland China).
   - You need an Apple ID with two-factor authentication. The certificate will show your legal name.
   - An organisation membership needs a D-U-N-S number.
   - Approval usually takes 1–2 days.
2. **Note your Team ID** under developer.apple.com → Account → Membership details. It has 10 characters, for
   example `ABCDE12345`.
3. **Create the certificate on a Mac.** Only the Account Holder can create this type.
   1. Open **Keychain Access → Certificate Assistant → Request a Certificate From a Certificate Authority**. Enter
      your email, choose **Saved to disk**, and save the `.certSigningRequest` file.
   2. Go to developer.apple.com → **Certificates, IDs & Profiles → Certificates → +** and choose
      **Developer ID Application**. Do **not** choose "Apple Development", "Apple Distribution" or "Developer ID
      Installer".
   3. Keep the default G2 Sub-CA, upload the CSR, then download the `.cer` and double-click it. It appears in the
      **login** keychain as "Developer ID Application: Your Name (TEAMID)", with a private key under it.
4. **Export the p12.**
   1. In Keychain Access, open **My Certificates**.
   2. Expand the certificate, select **both** the certificate and its private key, then right-click → **Export 2
      items…** → format **Personal Information Exchange (.p12)**.
   3. Set a strong export password.
5. **Notarisation credentials.** Choose **one** of these:
   - **Recommended: App Store Connect API key.**
     1. Go to <https://appstoreconnect.apple.com> → **Users and Access → Integrations → App Store Connect API →
        Team Keys → +**.
     2. Name it `NoobIDE notarization` and give it the access **Developer**.
     3. Download `AuthKey_<KEYID>.p8`. It can be downloaded **only once**.
     4. Note the **Key ID** and the **Issuer ID** shown above the list.
   - **Alternative: app-specific password.** Go to <https://account.apple.com> → **Sign-In and Security →
     App-Specific Passwords → +** and name it `NoobIDE notarization`.
6. **Create these environment secrets** (exact names):

| Secret                         | Value                                             | Needed for                                                       |
| ------------------------------ | ------------------------------------------------- | ---------------------------------------------------------------- |
| `APPLE_CERTIFICATE_P12_BASE64` | base64 of the exported `.p12`                     | always                                                           |
| `APPLE_CERTIFICATE_PASSWORD`   | the `.p12` export password                        | always                                                           |
| `APPLE_API_KEY_P8_BASE64`      | base64 of `AuthKey_<KEYID>.p8`                    | API key route                                                    |
| `APPLE_API_KEY_ID`             | the Key ID, for example `2X9R4HXF34`              | API key route                                                    |
| `APPLE_API_ISSUER`             | the Issuer ID (a UUID)                            | API key route                                                    |
| `APPLE_ID`                     | your Apple ID email                               | app-specific password route                                      |
| `APPLE_APP_SPECIFIC_PASSWORD`  | the app-specific password (`xxxx-xxxx-xxxx-xxxx`) | app-specific password route                                      |
| `APPLE_TEAM_ID`                | your Team ID                                      | always (verification checks that the DMG is signed by your team) |

Set the three "always" secrets plus **one** complete notarisation route. If both routes are complete, the API
key is used.

## 2. Windows: code signing (S28.3)

First choose your route (H.2; see the comparison in ADR 0027).

- **Route A: Azure Artifact Signing.** For individuals in the US or Canada, and for organisations in the US,
  Canada, EU or UK.
- **Route B: a CA certificate.** Open to everyone else, including individuals in mainland China.
- If neither is ready, you can release the beta unsigned. The install guides explain the SmartScreen prompt.

### Route A: Azure Artifact Signing (formerly "Trusted Signing")

1. Create an Azure account and subscription at <https://portal.azure.com>, and add a payment method. Basic costs
   about US$9.99 a month, and billing starts when the signing account is created.
2. Go to **Subscriptions → your subscription → Resource providers** and register `Microsoft.CodeSigning`.
3. Create an **Artifact Signing account**: search "Artifact Signing" (or "Trusted Signing") → Create.
   - Choose a region, for example East US. Note the **account name** and the region's **endpoint URL**, for
     example `https://eus.codesigning.azure.net/`.
   - Choose the Basic SKU.
4. In the account, open **Identity validation → New → Public**, choose Individual or Organization, and complete
   the verification. It takes a few business days.
5. When it is approved, open **Certificate profiles → Create → Public Trust**, pick the validated identity, and
   note the **profile name**.
6. Create the CI identity: **Microsoft Entra ID → App registrations → New registration** named `noobide-signing`.
   - Note the **Directory (tenant) ID** and the **Application (client) ID**.
   - Under **Certificates & secrets → New client secret**, create a secret that expires in 12 months or less, and
     note its **Value**.
7. Grant signing rights: go to the Artifact Signing account → **Access control (IAM) → Add role assignment** →
   **Artifact Signing Certificate Profile Signer** (older name: "Trusted Signing Certificate Profile Signer") →
   the `noobide-signing` app.
8. Create these environment secrets:

| Secret                      | Value                                                              |
| --------------------------- | ------------------------------------------------------------------ |
| `AZURE_TENANT_ID`           | Directory (tenant) ID                                              |
| `AZURE_CLIENT_ID`           | Application (client) ID                                            |
| `AZURE_CLIENT_SECRET`       | the client secret **Value**                                        |
| `ARTIFACT_SIGNING_ENDPOINT` | the endpoint URL, for example `https://eus.codesigning.azure.net/` |
| `ARTIFACT_SIGNING_ACCOUNT`  | the Artifact Signing account name                                  |
| `ARTIFACT_SIGNING_PROFILE`  | the certificate profile name                                       |

The workflow downloads `Microsoft.ArtifactSigning.Client` (version `ARTIFACT_SIGNING_CLIENT_VERSION` in
`release.yml`) from nuget.org. It refuses the dlib unless its Authenticode signature is valid and from Microsoft.

### Route B: CA code-signing certificate

1. Buy an **OV code-signing certificate** from a CA that offers **cloud signing usable in CI**, for example
   SSL.com eSigner, DigiCert KeyLocker or Certum SimplySign. Since June 2023, new keys can no longer be exported
   as a `.pfx`.
2. Complete the CA's identity validation.
3. Then do one of these:
   - If you have an exportable certificate (`.pfx`, for example an older one), create
     `WINDOWS_CERTIFICATE_PFX_BASE64` (base64 of the `.pfx`) and `WINDOWS_CERTIFICATE_PASSWORD`.
   - If it is cloud-only, tell the next agent session which vendor you chose. It adds that vendor's client setup
     step to `Prepare Windows signing`. No secret goes in until that step exists.

Configure **one** route. If secrets for both are set, the status step fails.

## 3. Dry run (prove it before a real release)

1. **Without secrets.** Do this now; it proves the skip path.
   1. Go to **Actions → Release → Run workflow** on `main`. Approve it if you set a reviewer.
   2. Expect, on both jobs:
      - The `Signing status` step logs `::notice::… signing … SKIPPED: secrets … are not set, so this build is
unsigned`.
      - The import and prepare steps are skipped.
      - `Verify signatures` logs `verify-signing SKIPPED`.
      - Artifacts are named `noobide-<target>-unsigned`, and the run is green.
2. **With secrets.** Add them, then run the workflow again on `main`. Expect:
   - `Signing status`: `macOS signing ENABLED: Developer ID certificate, notarisation via App Store Connect API
key` (or `Apple ID`), and `Windows signing ENABLED: artifact-signing` (or `certificate`).
   - `Make installers` on macOS waits several minutes for notarisation, once for the app and once for the DMG.
   - `Verify signatures` shows `PASS` and `ok` lines for `spctl accepted`, `spctl source` (`Notarized Developer
ID`) and `stapler validate` on the DMG. On Windows it shows `signtool verify` (signer = your validated name),
     `no errors` and `timestamped` for `NoobIDE-Setup.exe` and `noobide.exe`. The last line reads
     `verify-signing: N artifact(s) signed and verified`.
   - Artifacts are named `noobide-<target>-signed`.
3. **Check by hand.**
   - On a Mac, download the DMG artifact and run `spctl -a -vvv -t install NoobIDE-*.dmg` and
     `xcrun stapler validate NoobIDE-*.dmg`. Then open the app normally; that is S28.5.
   - On Windows, run `signtool verify /pa /v NoobIDE-Setup.exe`, or open **Properties → Digital Signatures**.
4. **Record the evidence.** Give the run URL to the next agent session, which sets:
   - `S28.2 done --evidence "release.yml run <url>: verify-signing spctl+stapler PASS"`
   - `S28.3 done --evidence "release.yml run <url>: signtool verify PASS Setup.exe + noobide.exe"`
   - and closes H.2.
5. **Optional: local macOS dry run** with the certificate in your login keychain:

   ```bash
   export APPLE_SIGNING_IDENTITY="Developer ID Application: Your Name (ABCDE12345)"
   export APPLE_KEYCHAIN_PATH="$HOME/Library/Keychains/login.keychain-db"
   export APPLE_API_KEY_PATH="$HOME/keys/AuthKey_XXXX.p8" APPLE_API_KEY_ID=XXXX APPLE_API_ISSUER=uuid
   npm run make && node scripts/verify-signing.mjs
   ```

   On Windows, `signtool verify` reporting "The file is being used by another process" (the antivirus scanner or the
   indexer still holds a freshly written file) is retried a few times with a short backoff; every other result,
   including a missing or invalid signature, is reported at once.

## 4. A real release

Push a tag such as `v0.1.0` from `main` (`git tag v0.1.0 && git push origin v0.1.0`). The same workflow runs and
uploads the signed installers as run artifacts, then creates a draft GitHub Release once both targets pass.
See [delivery.md](delivery.md) for checksums, retry rules and the first-run checklist. Public publishing remains
a separate, manual owner decision after downloaded-installer acceptance.

## Troubleshooting

| Log line                                                                     | Fix                                                                                                |
| ---------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `::error::macOS notarisation (Apple ID): some secrets are set but … missing` | Add the missing secret or delete the others in that group                                          |
| `The certificate is not a Developer ID Application identity`                 | You exported a different certificate type, or the p12 has no private key; redo step 1.4            |
| `DMG notarisation Invalid (submission <id>)`                                 | `xcrun notarytool log <id> --key AuthKey.p8 --key-id … --issuer …` on a Mac shows why              |
| `spctl source: Unnotarized Developer ID`                                     | Notarisation or stapling did not run; check the `Make installers` log                              |
| `signtool verify: SignTool Error: No signature found`                        | The route was not active; check the `Signing status` and `Prepare Windows signing` steps           |
| `timestamped: no timestamp`                                                  | The timestamp server was unreachable; re-run. An untimestamped signature dies with the certificate |
| `Azure.CodeSigning.Dlib.dll is not validly signed by Microsoft`              | Do not bypass this. Check the client version in `release.yml`                                      |
| 403 from Artifact Signing                                                    | Role assignment (step A.7) missing, or the endpoint region does not match the account              |

Rotate secrets when the app-specific password, API key or client secret is revoked or expires. Apple
Developer ID certificates are valid for 5 years; Azure client secrets for the period you chose.
