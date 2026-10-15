import { useI18n } from '../i18n/I18nProvider';
import { otherLocale, type MessageKey } from '../i18n/index';
import { revealLabelKey, type PlatformId } from '../../platform/labels';
import { withShortcut } from '../commands/useCommands'; // S24.1
import type { OpenedProject } from '../../shared/ipc/contract';
import type { SaveStatus } from './save-machine';
import { CodeIcon, DotIcon, RevealIcon, SaveStateIcon, SearchIcon } from './icons';
import { commandShortcutLabel } from '../../shared/commands';
import type { NarrowView } from './layout';
import { AppMenu, type AppMenuItem } from './AppMenu'; // S13

interface TopBarProps {
  platform: PlatformId;
  project: OpenedProject | null;
  /** `null` when no file is open. */
  save: SaveStatus | null;
  onReveal: () => void;
  /** Present only in a narrow window (S30.4). */
  narrow?: { view: NarrowView; onShow: (view: NarrowView) => void } | undefined;
  /** S13: commands of the menu next to the project (close project, open logs folder). */
  menuItems?: readonly AppMenuItem[] | undefined;
  /** S40.5: opens the command palette. */
  onOpenPalette?: (() => void) | undefined;
}

const SAVE_LABEL: Record<SaveStatus, MessageKey> = {
  clean: 'save.clean',
  dirty: 'save.dirty',
  saving: 'save.saving',
  saved: 'save.saved',
  failed: 'save.failed',
  conflict: 'save.conflict',
  deleted: 'save.deleted', // S11.3
};

export function TopBar({ platform, project, save, onReveal, narrow, menuItems, onOpenPalette }: TopBarProps) {
  const { t, locale, setLocale } = useI18n();
  return (
    <header className="region topbar" role="banner" aria-label={t('region.topbar')} data-testid="region-topbar">
      <span className="app-mark" aria-hidden="true">
        <CodeIcon />
      </span>
      <span className="app-name">{t('app.name')}</span>
      <div className="project">
        <span className="project-name" data-testid="project-name">
          {project ? project.name : t('topbar.noProject')}
        </span>
        <span className="project-detail" data-testid="project-path">
          {project ? project.rootPath : t('topbar.sampleNotice')}
        </span>
      </div>
      {/* S40.3: project actions share one glass group */}
      {(project || (menuItems && menuItems.length > 0)) && (
        <div className="toolbar-group">
          {project && (
            <button
              type="button"
              className="icon-button reveal-button"
              aria-label={t(revealLabelKey(platform))}
              title={t(revealLabelKey(platform))}
              data-testid="reveal-project"
              onClick={onReveal}
            >
              <RevealIcon />
            </button>
          )}
          {menuItems && <AppMenu items={menuItems} />}
        </div>
      )}
      {narrow && (
        <div className="segmented" role="group" aria-label={t('narrow.switch')} data-testid="narrow-switch">
          {(['code', 'preview'] as const).map((view) => (
            <button
              key={view}
              type="button"
              className="segment"
              aria-pressed={narrow.view === view}
              onClick={() => narrow.onShow(view)}
            >
              {t(view === 'code' ? 'narrow.code' : 'narrow.preview')}
            </button>
          ))}
        </div>
      )}
      <span className="spacer" />
      <span
        className={`save-status${save ? ` save-${save}` : ''}`}
        role="status"
        aria-label={t('topbar.saveStatus')}
        title={save ? withShortcut(t('save.shortcut'), 'save', platform) : undefined}
        data-testid="save-status"
        data-state={save ?? 'none'}
      >
        {save ? <SaveStateIcon state={save} /> : <DotIcon />}
        {save ? t(SAVE_LABEL[save]) : t('topbar.saveStatus.noFile')}
      </span>
      <div className="toolbar-group">
        {onOpenPalette && (
          <button
            type="button"
            className="palette-button"
            aria-haspopup="dialog"
            aria-label={withShortcut(t('palette.open'), 'command-palette', platform)}
            title={withShortcut(t('palette.open'), 'command-palette', platform)}
            data-testid="open-palette"
            onClick={onOpenPalette}
          >
            <SearchIcon />
            <span className="palette-button-label">{t('palette.open')}</span>
            <kbd className="kbd">{commandShortcutLabel('command-palette', platform)}</kbd>
          </button>
        )}
        <button
          type="button"
          className="quiet-button"
          title={t('topbar.language')}
          data-testid="switch-language"
          onClick={() => setLocale(otherLocale(locale))}
        >
          {t('topbar.switchLanguage')}
        </button>
      </div>
    </header>
  );
}
