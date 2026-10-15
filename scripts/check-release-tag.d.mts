// Types for scripts/check-release-tag.mjs (used by tests/integration/release-workflow.test.ts).
export function checkReleaseTag(input: { refType: string; refName: string; version: unknown }): {
  ok: boolean;
  message: string;
};
