import { useCallback, useEffect, useRef, useState } from 'react';
import type { OpenedProject } from '../../shared/ipc/contract';
import { useI18n } from '../i18n/I18nProvider';
import { PlusIcon, SmallFolderIcon, WarningIcon } from '../workbench/icons';
import { protectedFolderMessage } from '../workbench/file-op-messages';
import { recentRowView, type RecentProject, type RecentProjectsSource } from './welcome-model';
import type { AiHistoryApi } from '../../shared/ipc/ai-history-contract';
import { aiHistoryBridge } from '../ai/chat-history';
import { fill } from '../recovery/format';
import './welcome.css';

interface WelcomeScreenProps {
  /** Absent outside Electron (no bridge): the buttons are then not offered. */
  onCreate: (() => void) | undefined;
  onOpenFolder: (() => void) | undefined;
  /** The recent-projects store (S13.3), when this build has one; otherwise the list is not shown. */
  recent: RecentProjectsSource | undefined;
  onOpenRecent: (project: OpenedProject) => void;
  /** S39.1: saved AI chats of a recent entry (removing it offers to delete them). Default: the preload bridge. */
  chats?: Pick<AiHistoryApi, 'countRecentChats' | 'deleteRecentChats'> | undefined;
}

/**
 * Welcome screen (S20.2, wireframe welcome 1a), shown while no project is open: one prominent "Create my first
 * webpage", "Open folder…" and the recent projects with their full paths. A recent project whose folder is gone is
 * marked with a warning icon and the text "folder not found", and can only be removed from the list — nothing on
 * disk is ever deleted from here.
 */
export function WelcomeScreen({
  onCreate,
  onOpenFolder,
  recent,
  onOpenRecent,
  chats = aiHistoryBridge(),
}: WelcomeScreenProps) {
  const { t } = useI18n();
  const [projects, setProjects] = useState<readonly RecentProject[] | null>(null);
  const [failed, setFailed] = useState<{ readonly id: string; readonly protectedFolder: boolean } | null>(null);
  const createRef = useRef<HTMLButtonElement>(null);
  // S39.1: the entry being removed has saved AI chats: ask whether to delete them too.
  const [askChats, setAskChats] = useState<{ readonly id: string; readonly count: number } | null>(null);

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
    if (opened && opened !== 'protected-folder') onOpenRecent(opened);
    else {
      setFailed({ id: project.id, protectedFolder: opened === 'protected-folder' });
      reload();
    }
  };

  const removeNow = async (id: string, deleteChats: boolean) => {
    setAskChats(null);
    if (deleteChats) await chats?.deleteRecentChats({ id }).catch(() => undefined);
    await recent?.remove(id).catch(() => undefined);
    reload();
  };

  const remove = async (project: RecentProject) => {
    const counted = chats ? await chats.countRecentChats({ id: project.id }).catch(() => null) : null;
    if (counted?.ok && counted.value.count > 0) setAskChats({ id: project.id, count: counted.value.count });
    else await removeNow(project.id, false);
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
                    {failed?.id === project.id && (
                      <small className="welcome-recent-error" role="alert">
                        {failed.protectedFolder ? protectedFolderMessage(t) : t('welcome.recentOpenFailed')}
                      </small>
                    )}
                    {askChats?.id === project.id && (
                      <span className="welcome-recent-chats" role="group" data-testid="welcome-recent-chats">
                        <small>{fill(t('welcome.recentChats.ask'), { name: project.name, n: askChats.count })}</small>
                        <span className="welcome-actions">
                          <button
                            type="button"
                            className="secondary-button"
                            data-testid="welcome-recent-chats-delete"
                            onClick={() => void removeNow(project.id, true)}
                          >
                            {t('welcome.recentChats.delete')}
                          </button>
                          <button
                            type="button"
                            className="secondary-button"
                            data-testid="welcome-recent-chats-keep"
                            onClick={() => void removeNow(project.id, false)}
                          >
                            {t('welcome.recentChats.keep')}
                          </button>
                          <button type="button" className="quiet-button" onClick={() => setAskChats(null)}>
                            {t('welcome.recentChats.cancel')}
                          </button>
                        </span>
                      </span>
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
