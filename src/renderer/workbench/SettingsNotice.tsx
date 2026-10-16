import type { SettingsSnapshot } from '../../shared/ipc/app-data-contract';
import { useI18n } from '../i18n/I18nProvider';
import { WarningIcon } from './icons';

/**
 * S13.1: the settings file in app data could not be used as it was. A corrupt one was kept as a backup and the defaults
 * were applied; say so once, with where the backup is. S28.4: one written by a newer NoobIDE is read as far as this
 * version understands it and left unchanged (changes made now are not saved).
 */
export function SettingsNotice({ snapshot, onDismiss }: { snapshot: SettingsSnapshot; onDismiss(): void }) {
  const { t } = useI18n();
  const newer = snapshot.notice === 'newer-version';
  return (
    <div className="inline-alert save-alert app-notice" role="alert" data-testid="settings-notice">
      <WarningIcon size={16} />
      <div className="save-alert-body">
        <strong>{t(newer ? 'settings.newer' : 'settings.corrupt')}</strong>{' '}
        {t(newer ? 'settings.readOnly' : 'settings.reset')}
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
