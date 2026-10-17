import { useEffect, useState } from 'react';
import { useI18n } from '../i18n/I18nProvider';
import type { PortabilityApi, PortabilityReport } from '../../shared/ipc/app-data-contract';
import { fill } from './file-op-messages';
import { transferNoticeView } from './transfer-notice';
import { WarningIcon } from './icons';
import { useAutoDismiss } from './useAutoDismiss';

/**
 * S13.5: after a project opens, main checks it read-only for what breaks between Windows and macOS (names, case and
 * Unicode-form conflicts, mixed line endings) and this non-blocking notice lists the findings. Nothing is renamed or
 * rewritten; the user decides what to change.
 */
export function TransferNotice({ api, projectId }: { api: PortabilityApi | undefined; projectId: string | null }) {
  const { t } = useI18n();
  const [report, setReport] = useState<{ projectId: string; report: PortabilityReport } | null>(null);
  const [dismissed, setDismissed] = useState<string | null>(null);

  useEffect(() => {
    if (!api || projectId === null) return;
    let current = true;
    void api.check({ projectId }).then((result) => {
      if (current && result.ok) setReport({ projectId, report: result.value });
    });
    return () => {
      current = false;
    };
  }, [api, projectId]);

  if (!report || report.projectId !== projectId || dismissed === projectId) return null;
  const view = transferNoticeView(t, report.report);
  if (!view) return null;
  return <TransferNoticeView view={view} onDismiss={() => setDismissed(projectId)} />;
}

/** S47.5: a report, not a failure — it leaves by itself unless the user is reading it (hover / focus). */
function TransferNoticeView({
  view,
  onDismiss,
}: {
  view: NonNullable<ReturnType<typeof transferNoticeView>>;
  onDismiss(): void;
}) {
  const { t } = useI18n();
  const hold = useAutoDismiss(onDismiss);
  return (
    <div className="inline-alert save-alert app-notice" role="status" data-testid="transfer-notice" {...hold}>
      <WarningIcon size={15} />
      <div className="save-alert-body">
        <strong>{t('transfer.title')}</strong>
        <ul className="alert-detail transfer-issues">
          {view.lines.map((line, i) => (
            <li key={`${i}:${line}`} data-testid="transfer-issue">
              {line}
            </li>
          ))}
        </ul>
        {view.more > 0 && <span className="alert-detail">{fill(t('transfer.more'), { n: String(view.more) })}</span>}
        {view.truncated && <span className="alert-detail">{t('transfer.truncated')}</span>}
        <span className="alert-actions">
          <button type="button" className="secondary-button" data-testid="transfer-notice-dismiss" onClick={onDismiss}>
            {t('disk.dismiss')}
          </button>
        </span>
      </div>
    </div>
  );
}
