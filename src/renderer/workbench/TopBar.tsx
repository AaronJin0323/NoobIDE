import { useLayoutEffect, useRef } from 'react';
import { useI18n } from '../i18n/I18nProvider';
import { otherLocale, type MessageKey } from '../i18n/index';
import { revealLabelKey, type PlatformId } from '../../platform/labels';
import { withShortcut } from '../commands/useCommands'; // S24.1
import type { OpenedProject } from '../../shared/ipc/contract';
import type { SaveStatus } from './save-machine';
import { DotIcon, NewFileIcon, NoobIdeMark, RevealIcon, SaveIcon, SaveStateIcon, SearchIcon } from './icons';
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
  /** Saves the active file: the same path as Ctrl+S / ⌘S (the `save` command). */
  onSave?: (() => void) | undefined;
  /** Narrow window only: opens the file drawer and starts a new file (its button lives in the hidden files panel). */
  onNewFile?: (() => void) | undefined;
}

/** The Save button is offered (prominent) while there is something to save; otherwise the calm state word shows. */
export function saveButtonShown(save: SaveStatus | null): boolean {
  return save === 'dirty' || save === 'failed';
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

export function TopBar({
  platform,
  project,
  save,
  onReveal,
  narrow,
  menuItems,
  onOpenPalette,
  onSave,
  onNewFile,
}: TopBarProps) {
  const { t, locale, setLocale } = useI18n();
  // The Save button leaves once the file is saved; if it had the keyboard focus, the focus stays in the save group
  // (on the state word) instead of dropping to the page body.
  const saveShown = onSave !== undefined && saveButtonShown(save);
  const saveRef = useRef<HTMLButtonElement>(null);
  const statusRef = useRef<HTMLSpanElement>(null);
  // Read before the commit removes the button (removing a focused node may or may not fire blur).
  const saveHadFocus = !saveShown && saveRef.current !== null && document.activeElement === saveRef.current;
  useLayoutEffect(() => {
    if (saveHadFocus) statusRef.current?.focus();
  }, [saveHadFocus]);
  return (
    <header className="region topbar" role="banner" aria-label={t('region.topbar')} data-testid="region-topbar">
      <span className="app-mark" aria-hidden="true">
        <NoobIdeMark />
      </span>
      <span className="app-name">{t('app.name')}</span>
      <div className="project">
        <span className="project-name" data-testid="project-name">
          {project ? project.name : t('topbar.noProject')}
        </span>
        {project && (
          <span className="project-detail" data-testid="project-path">
            {project.rootPath}
          </span>
        )}
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
      {narrow && onNewFile && (
        <button
          type="button"
          className="secondary-button topbar-new-file"
          title={t('files.newFile')}
          data-testid="topbar-new-file"
          onClick={onNewFile}
        >
          <NewFileIcon />
          <span className="topbar-new-file-label">{t('files.newFile')}</span>
        </button>
      )}
      <span className="spacer" />
      {/* The save state is always announced (role=status); while there is something to save a prominent Save button
          sits next to it, so saving never depends on knowing the shortcut. */}
      <div className="save-group">
        <span
          className={`save-status${save ? ` save-${save}` : ''}`}
          role="status"
          aria-label={t('topbar.saveStatus')}
          title={save ? withShortcut(t('save.shortcut'), 'save', platform) : undefined}
          data-testid="save-status"
          ref={statusRef}
          tabIndex={-1}
          data-state={save ?? 'none'}
        >
          {save ? <SaveStateIcon state={save} /> : <DotIcon />}
          <span className="save-status-text">{save ? t(SAVE_LABEL[save]) : t('topbar.saveStatus.noFile')}</span>
        </span>
        {saveShown && (
          <button
            type="button"
            className="save-button"
            aria-label={withShortcut(t('save.shortcut'), 'save', platform)}
            title={withShortcut(t('save.shortcut'), 'save', platform)}
            data-testid="topbar-save"
            onClick={onSave}
            ref={saveRef}
          >
            <SaveIcon />
            <span>{t('save.shortcut')}</span>
            <kbd className="kbd save-button-kbd" aria-hidden="true">
              {commandShortcutLabel('save', platform)}
            </kbd>
          </button>
        )}
      </div>
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
