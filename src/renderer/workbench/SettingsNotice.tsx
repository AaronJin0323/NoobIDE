import type { SettingsSnapshot } from '../../shared/ipc/app-data-contract';
import { useI18n } from '../i18n/I18nProvider';
import { Notice } from './Notice';

/**
 * S13.1: the settings file in app data could not be used as it was. A corrupt one was kept as a backup and the defaults
 * were applied; say so once, with where the backup is. S28.4: one written by a newer NoobIDE is read as far as this
 * version understands it and left unchanged (changes made now are not saved). S50.2: on the shared Notice.
 */
export function SettingsNotice({ snapshot, onDismiss }: { snapshot: SettingsSnapshot; onDismiss(): void }) {
  const { t } = useI18n();
  const newer = snapshot.notice === 'newer-version';
  return (
    <Notice
      tone="warning"
      role="alert"
      testId="settings-notice"
      title={t(newer ? 'notice.settings.newerTitle' : 'notice.settings.corruptTitle')}
      body={t(newer ? 'notice.settings.newerBody' : 'settings.reset')}
      details={
        snapshot.backupPath ? (
          <span className="notice-path" data-testid="settings-backup">
            {t('settings.backup')} {snapshot.backupPath}
          </span>
        ) : undefined
      }
      detailsLabel={t('notice.details')}
      actions={
        <button type="button" className="secondary-button" data-testid="settings-notice-dismiss" onClick={onDismiss}>
          {t('disk.dismiss')}
        </button>
      }
    />
  );
}
