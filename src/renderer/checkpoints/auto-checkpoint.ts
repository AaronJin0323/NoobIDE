import type { CheckpointCause, CheckpointsApi } from '../../shared/ipc/checkpoints-contract';

/**
 * Automatic checkpoints (S56.3): a whole-project safety net taken right before a bulk change — an AI agent proposal
 * being applied, a local-history restore (a version, a deleted file, or a whole agent turn undone). Labelled with its
 * cause; pruned by the store's policy (named checkpoints never are).
 *
 * The operation goes ahead when the checkpoint cannot be taken (limits, storage full): it has its own per-file safety
 * net in local history (`before-ai` / `before-restore` versions), and a beginner must never be blocked from undoing.
 * The restore of a *checkpoint* is different: it aborts without its safety checkpoint (checkpoint-restore.ts).
 */
export type AutoCause = Exclude<CheckpointCause, 'manual' | 'before-checkpoint-restore'>;

export interface AutoCheckpointOutcome {
  readonly taken: boolean;
  /** An identical project was already the newest checkpoint: nothing new was stored. */
  readonly deduped?: boolean;
  readonly code?: string;
}

/** Longest name sent (the store keeps up to 80 characters; the label is the user's request, possibly long). */
const MAX_NAME = 80;

export function autoCheckpointName(name: string): string {
  const line = name.replace(/\s+/g, ' ').trim();
  return line.length > MAX_NAME ? `${line.slice(0, MAX_NAME - 1)}…` : line;
}

export async function takeAutoCheckpoint(
  api: Pick<CheckpointsApi, 'create'> | undefined,
  projectId: string,
  cause: AutoCause,
  name: string,
): Promise<AutoCheckpointOutcome> {
  if (!api) return { taken: false, code: 'no-bridge' };
  try {
    const result = await api.create({ projectId, name: autoCheckpointName(name), kind: 'auto', cause });
    return result.ok ? { taken: true, deduped: result.value.deduped } : { taken: false, code: result.code };
  } catch {
    return { taken: false, code: 'failed' };
  }
}
