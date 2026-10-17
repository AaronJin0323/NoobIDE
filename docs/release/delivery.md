# Continuous delivery

CI checks every PR and main push with two isolated Electron test shards per platform. Release builds
run on version tags or by manual dispatch. Once both native builds pass verify, the full E2E suite,
installer creation, architecture inspection and configured signature checks, a tag run creates a
**draft GitHub Release** with Windows x64 and macOS arm64 installers, ZIPs and SHA256SUMS.txt.

Signing status appears in every asset name and in the draft notes. Missing credentials still permit
an unsigned internal-validation draft; partially configured signing fails. Draft delivery never
publishes publicly and never updates an existing release. Public release still requires the owner
acceptance/go-no-go in PLAN §5/§11 and H.8. This is installer delivery, not an automatic app updater.

## Setup and first run

1. Merge the workflow changes into main with Actions enabled. The built-in GITHUB_TOKEN is enough;
   no personal access token is required. The delivery job alone requests contents: write and
   actions: read; build jobs remain read-only. If organization policy restricts token permissions,
   allow these scopes for the repository.
2. Configure the release environment and signing secrets using [signing.md](signing.md). Keep
   main and v* allowed by its deployment branch/tag rules. Reviewers, if configured, approve builds.
3. Run Actions → Release → Run workflow on main for a dry run. Both targets should pass and upload
   installers; the delivery job should skip, with no release created.
4. When ready for a versioned draft, update package.json and package-lock.json together, for example
   `npm version 0.1.0 --no-git-tag-version`. Commit, review and merge that version change first.
5. On the exact merged commit, create and push `v0.1.0`. The tag must match package.json; a mismatch
   fails before building. Never move/reuse a published version tag.
6. Confirm the draft has one installer and ZIP per platform plus SHA256SUMS.txt, that the source
   commit is correct, and that signing labels match the build logs. Download and check hashes.
   Complete clean-machine installation/upgrade and signing acceptance before publishing manually.

## Failures and retries

Any failed or cancelled platform job prevents delivery. Fix the failure before rerunning. Download
selection is restricted to artifacts from the same run ID; it never picks a different run's binaries.
The staging helper refuses missing/ambiguous platforms, missing installers or ZIPs, duplicate names,
symlinks and existing staging directories. Asset names include version, platform and signing status.

If creation or upload fails after a draft was created, inspect that draft first. A rerun deliberately
fails instead of replacing assets or notes. Remove only the incomplete draft through GitHub's UI
(keep the tag), then rerun the delivery job while this run's artifacts remain available (30 days).
If artifacts expired, rebuild the tag. Never delete a published release to bypass this guard.

## Validation status

Automated fixture tests cover assembly, exact byte checksums, provenance validation, missing and
ambiguous targets, duplicate assets and overwrite refusal. Workflow tests check tag-only delivery,
both-platform dependencies, E2E ordering and restricted permissions. Creating a real hosted draft
and macOS signed acceptance remain rollout checks; local tests do not prove those external services.

References: [GitHub CLI release creation](https://cli.github.com/manual/gh_release_create),
[artifact download](https://cli.github.com/manual/gh_run_download).
