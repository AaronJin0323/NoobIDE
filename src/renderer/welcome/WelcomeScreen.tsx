import { useCallback, useEffect, useRef, useState } from 'react';
import type { OpenedProject } from '../../shared/ipc/contract';
import { useI18n } from '../i18n/I18nProvider';
import { PlusIcon, SmallFolderIcon, WarningIcon } from '../workbench/icons';
import { recentRowView, type RecentProject, type RecentProjectsSource } from './welcome-model';
import './welcome.css';

interface WelcomeScreenProps {
  /** Absent outside Electron (no bridge): the buttons are then not offered. */
  onCreate: (() => void) | undefined;
  onOpenFolder: (() => void) | undefined;
  /** The recent-projects store (S13.3), when this build has one; otherwise the list is not shown. */
  recent: RecentProjectsSource | undefined;
  onOpenRecent: (project: OpenedProject) => void;
}

/**
 * Welcome screen (S20.2, wireframe welcome 1a), shown while no project is open: one prominent "Create my first
 * webpage", "Open folder…" and the recent projects with their full paths. A recent project whose folder is gone is
 * marked with a warning icon and the text "folder not found", and can only be removed from the list — nothing on
 * disk is ever deleted from here.
 */
export function WelcomeScreen({ onCreate, onOpenFolder, recent, onOpenRecent }: WelcomeScreenProps) {
  const { t } = useI18n();
  const [projects, setProjects] = useState<readonly RecentProject[] | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const createRef = useRef<HTMLButtonElement>(null);

  const reload = useCallback(() => {
    if (!recent) return;
    void recent.list().then(setProjects, () => setProjects([]));
  }, [recent]);

  useEffect(reload, [reload]);

  // The primary action is first in focus order and focused on arrival, so Enter starts it (wireframe note 2).
  useEffect(() => {
    if (document.activeElement === document.body || document.activeElement === null) createRef.current?.focus();
  }, []);

  const open = async (project: RecentProject) => {
    if (!recent) return;
    setFailed(null);
    const opened = await recent.open(project.id).catch(() => null);
    if (opened) onOpenRecent(opened);
    else {
      setFailed(project.id);
      reload();
    }
  };

  const remove = async (project: RecentProject) => {
    await recent?.remove(project.id).catch(() => undefined);
    reload();
  };

  return (
    <section className="welcome" aria-labelledby="welcome-title" data-testid="welcome">
      <div className="welcome-start">
        <h2 id="welcome-title" className="welcome-title">
          {t('welcome.title')}
        </h2>
        <p className="welcome-lead">{t('welcome.lead')}</p>
        <div className="welcome-actions">
          {onCreate && (
            <button
              ref={createRef}
              type="button"
              className="primary-button welcome-create"
              data-testid="welcome-create"
              onClick={onCreate}
            >
              <PlusIcon />
              {t('welcome.create')}
            </button>
          )}
          {onOpenFolder && (
            <button
              type="button"
              className="secondary-button welcome-open"
              data-testid="welcome-open-folder"
              onClick={onOpenFolder}
            >
              <SmallFolderIcon />
              {t('welcome.openFolder')}
            </button>
          )}
        </div>
      </div>
      {recent && (
        <div className="welcome-recent" data-testid="welcome-recent">
          <h3 className="welcome-recent-title">{t('welcome.recent')}</h3>
          {projects && projects.length === 0 && <p className="dialog-hint">{t('welcome.recentEmpty')}</p>}
          <ul className="welcome-recent-list">
            {projects?.map((project) => {
              const view = recentRowView(project);
              return (
                <li key={project.id} className="welcome-recent-item" data-testid="welcome-recent-item">
                  <span className="welcome-recent-text">
                    <span className="welcome-recent-name">
                      {project.name}
                      {view.statusKey && (
                        <span className="welcome-recent-missing" data-testid="welcome-recent-missing">
                          <WarningIcon />
                          {t(view.statusKey)}
                        </span>
                      )}
                    </span>
                    <small className="welcome-recent-path">{project.path}</small>
                    {failed === project.id && (
                      <small className="welcome-recent-error" role="alert">
                        {t('welcome.recentOpenFailed')}
                      </small>
                    )}
                  </span>
                  <button
                    type="button"
                    className="secondary-button"
                    title={view.action === 'remove' ? t('welcome.recentRemoveHint') : undefined}
                    onClick={() => void (view.action === 'open' ? open(project) : remove(project))}
                  >
                    {t(view.actionKey)}
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      )}
      <p className="welcome-sample-note">{t('welcome.sampleBelow')}</p>
    </section>
  );
}
