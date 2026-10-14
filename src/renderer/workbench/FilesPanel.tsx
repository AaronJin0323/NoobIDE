import { useI18n } from '../i18n/I18nProvider';
import { FolderIcon } from './icons';

export function FilesPanel({ hidden }: { hidden: boolean }) {
  const { t } = useI18n();
  return (
    <nav
      id="region-files"
      className="region panel files"
      aria-label={t('region.files')}
      data-testid="region-files"
      hidden={hidden}
    >
      <div className="panel-header">
        <h2 className="region-title">{t('region.files')}</h2>
      </div>
      <div className="empty-state">
        <span className="empty-icon">
          <FolderIcon />
        </span>
        <p className="empty-title">{t('files.empty')}</p>
        <p className="empty-detail">{t('files.emptyHint')}</p>
      </div>
    </nav>
  );
}
