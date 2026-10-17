import type {
  CheckpointCause,
  CheckpointErrorCode,
  CheckpointRefusal,
  CheckpointUsageInfo,
} from '../../shared/ipc/checkpoints-contract';
import type { MessageKey } from '../i18n/index';
import { fill, formatBytes } from '../recovery/format';
import type { RestoreReport } from './checkpoint-restore';

/** Pure view logic of the Checkpoints window (S56.2): what explains a refusal, how usage and outcomes read. */
type Translate = (key: MessageKey, count?: number) => string;

export function causeKey(cause: CheckpointCause): MessageKey {
  return `checkpoints.cause.${cause}` as MessageKey;
}

const ERROR_KEYS: Partial<Record<string, MessageKey>> = {
  'too-many-files': 'checkpoints.error.too-many-files',
  'file-too-large': 'checkpoints.error.file-too-large',
  'checkpoint-too-large': 'checkpoints.error.checkpoint-too-large',
  'storage-full': 'checkpoints.error.storage-full',
  'too-many-named': 'checkpoints.error.too-many-named',
  'invalid-name': 'checkpoints.error.invalid-name',
  'unsupported-path': 'checkpoints.error.unsupported-path',
  'project-changed': 'checkpoints.error.project-changed',
  unavailable: 'checkpoints.error.unavailable',
  'read-failed': 'checkpoints.error.read-failed',
  damaged: 'checkpoints.error.damaged',
};

/** The explanation of a failed checkpoint operation, with the file and sizes concerned (never contents). */
export function checkpointErrorText(
  t: Translate,
  code: CheckpointErrorCode | 'forbidden-sender' | 'invalid-request',
  detail?: CheckpointRefusal,
): string {
  const key = ERROR_KEYS[code] ?? 'checkpoints.error.generic';
  const n = detail?.bytes ?? 0;
  return fill(t(key), {
    path: detail?.relPath ?? '',
    n,
    size: formatBytes(n),
    limit:
      code === 'too-many-files' || code === 'too-many-named' || code === 'invalid-name'
        ? (detail?.limit ?? 0)
        : formatBytes(detail?.limit ?? 0),
  });
}

export function usageText(t: Translate, usage: CheckpointUsageInfo): { usage: string; policy: string } {
  return {
    usage: fill(t('checkpoints.usage'), {
      size: formatBytes(usage.totalBytes),
      max: formatBytes(usage.maxTotalBytes),
      named: usage.named,
      auto: usage.automatic,
    }),
    policy: fill(t('checkpoints.policy'), {
      n: usage.maxAuto,
      days: usage.maxAutoAgeDays,
      files: usage.maxFiles,
      fileMax: formatBytes(usage.maxFileBytes),
    }),
  };
}

/** What a finished restore reports: one summary line, and one line per file that was not restored. */
export function restoreReportText(
  t: Translate,
  report: RestoreReport,
): { ok: boolean; summary: string; details: string[] } {
  if (report.aborted) {
    return {
      ok: false,
      summary: fill(t('checkpoints.restore.aborted'), { reason: checkpointErrorText(t, report.aborted.code) }),
      details: [],
    };
  }
  const parts = [fill(t('checkpoints.restore.done', report.restored.length), { n: report.restored.length })];
  if (report.trashed.length > 0) {
    parts.push(fill(t('checkpoints.restore.trashed', report.trashed.length), { n: report.trashed.length }));
  }
  const problems = report.skipped.filter((s) => s.reason !== 'added-kept');
  if (problems.length > 0) {
    parts.push(fill(t('checkpoints.restore.skipped', problems.length), { n: problems.length }));
  }
  return {
    ok: problems.length === 0,
    summary: parts.join(' '),
    details: report.skipped.map((s) => fill(t(`checkpoints.skip.${s.reason}` as MessageKey), { path: s.relPath })),
  };
}
