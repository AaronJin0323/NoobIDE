import { useI18n } from '../i18n/I18nProvider';
import type { OpenedProject } from '../../shared/ipc/contract';
import { FolderIcon, SmallFolderIcon, WarningIcon } from './icons';

interface FilesPanelProps {
  hidden: boolean;
  project: OpenedProject | null;
  activeRelPath: string | null;
  openFailed: boolean;
  /** Absent when the bridge is unavailable; the button is then not offered at all. */
  onOpenFolder: (() => void) | undefined;
  onOpenFile: (relPath: string) => void;
}

/** Flat file list of the open project (S03.3). The lazy tree, file operations and watcher arrive in S07/S08. */
export function FilesPanel({ hidden, project, activeRelPath, openFailed, onOpenFolder, onOpenFile }: FilesPanelProps) {
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
        {project && onOpenFolder && (
          <button
            type="button"
            className="icon-button"
            aria-label={t('files.openOther')}
            title={t('files.openOther')}
            data-testid="open-other-folder"
            onClick={onOpenFolder}
          >
            <SmallFolderIcon />
          </button>
        )}
      </div>
      {openFailed && (
        <p className="inline-alert" role="alert">
          <WarningIcon />
          {t('files.openFailed')}
        </p>
      )}
      {project ? (
        <>
          <ul className="file-list" aria-label={t('files.listLabel')} data-testid="file-list">
            {project.files.map((file) => (
              <li key={file.relPath}>
                <button
                  type="button"
                  className="file-row"
                  aria-current={file.relPath === activeRelPath ? 'true' : undefined}
                  title={file.relPath}
                  onClick={() => onOpenFile(file.relPath)}
                >
                  {file.relPath}
                </button>
              </li>
            ))}
          </ul>
          {project.truncated && <p className="empty-detail list-note">{t('files.truncated')}</p>}
        </>
      ) : (
        <div className="empty-state">
          <span className="empty-icon">
            <FolderIcon />
          </span>
          <p className="empty-title">{t('files.empty')}</p>
          {onOpenFolder && (
            <button type="button" className="primary-button" data-testid="open-folder" onClick={onOpenFolder}>
              {t('files.openFolder')}
            </button>
          )}
        </div>
      )}
    </nav>
  );
}
