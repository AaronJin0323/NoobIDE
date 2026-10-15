import { useI18n } from '../i18n/I18nProvider';
import { SmallFolderIcon } from './icons';

/**
 * S13.4: after a normal start reopened the last project, say so and show exactly where it is (PLAN §2: the user must
 * always be able to find their project).
 */
export function SessionNotice({ rootPath, onDismiss }: { rootPath: string; onDismiss(): void }) {
  const { t } = useI18n();
  return (
    // Information, not a failure: the neutral accent style (the heading says what happened; colour is not the cue).
    <div className="inline-alert info-alert app-notice" role="status" data-testid="session-restored">
      <SmallFolderIcon />
      <div className="save-alert-body">
        <strong>{t('session.restored')}</strong>
        <span className="alert-detail" data-testid="session-restored-path">
          {rootPath}
        </span>
        <span className="alert-actions">
          <button type="button" className="secondary-button" data-testid="session-restored-dismiss" onClick={onDismiss}>
            {t('disk.dismiss')}
          </button>
        </span>
      </div>
    </div>
  );
}
