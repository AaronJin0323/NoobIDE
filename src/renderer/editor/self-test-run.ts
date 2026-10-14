import { probeMonacoWorkers, type ProbeResult } from './worker-probe';
import { runCapabilityCases } from './capability-probe';
import { startedWorkers } from './monaco-setup';
import { parseCases, type CapabilityResult } from './capability-cases';
// The capability suite (S18.2) is bundled into this self-test chunk only; the workbench never loads it.
import suite from '../../../tests/fixtures/lang-capabilities/cases.json';

export interface SelfTestResult extends ProbeResult {
  /** Language capability cases (S18.1, S18.2), each run in a real editor against the bundled workers. */
  readonly capabilities: readonly CapabilityResult[];
}

/** Packaged-app self-test (S02.4 + S18.1): the workers answer, and every capability case passes. */
export async function runSelfTest(): Promise<SelfTestResult> {
  const workers = await probeMonacoWorkers();
  let capabilities: CapabilityResult[];
  try {
    capabilities = await runCapabilityCases(parseCases(suite));
  } catch (error) {
    capabilities = [{ id: 'suite', pass: false, seen: error instanceof Error ? error.message : String(error), ms: 0 }];
  }
  return {
    ...workers,
    // Every worker that ran during the whole self-test (the HTML worker starts with the HTML cases).
    workers: [...new Set(startedWorkers)],
    pass: workers.pass && capabilities.length > 0 && capabilities.every((c) => c.pass),
    capabilities,
  };
}
