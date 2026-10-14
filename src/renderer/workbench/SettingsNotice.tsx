import type { SettingsSnapshot } from '../../shared/ipc/app-data-contract';
import { useI18n } from '../i18n/I18nProvider';
import { WarningIcon } from './icons';

/**
 * S13.1: the settings file in app data could not be used (corrupt, or written by a newer NoobIDE). It was kept as a
 * backup and the defaults were applied; say so once, with where the backup is.
 */
export function SettingsNotice({ snapshot, onDismiss }: { snapshot: SettingsSnapshot; onDismiss(): void }) {
  const { t } = useI18n();
  return (
    <div className="inline-alert save-alert app-notice" role="alert" data-testid="settings-notice">
      <WarningIcon size={15} />
      <div className="save-alert-body">
        <strong>{t(snapshot.notice === 'newer-version' ? 'settings.newer' : 'settings.corrupt')}</strong>{' '}
        {t('settings.reset')}
        {snapshot.backupPath && (
          <span className="alert-detail" data-testid="settings-backup">
            {t('settings.backup')} {snapshot.backupPath}
          </span>
        )}
        <span className="alert-actions">
          <button type="button" className="secondary-button" data-testid="settings-notice-dismiss" onClick={onDismiss}>
            {t('disk.dismiss')}
          </button>
        </span>
      </div>
    </div>
  );
}
