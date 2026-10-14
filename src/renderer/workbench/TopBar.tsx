import { useI18n } from '../i18n/I18nProvider';
import { otherLocale, type MessageKey } from '../i18n/index';
import { revealLabelKey, shortcutLabel, type PlatformId } from '../../platform/labels';
import type { OpenedProject } from '../../shared/ipc/contract';
import type { SaveState } from './document-state';
import { CodeIcon, DotIcon, RevealIcon, SaveStateIcon } from './icons';
import type { NarrowView } from './layout';

interface TopBarProps {
  platform: PlatformId;
  project: OpenedProject | null;
  /** `null` when no file is open. */
  save: SaveState | null;
  onReveal: () => void;
  /** Present only in a narrow window (S30.4). */
  narrow?: { view: NarrowView; onShow: (view: NarrowView) => void } | undefined;
}

const SAVE_LABEL: Record<SaveState, MessageKey> = {
  clean: 'save.clean',
  dirty: 'save.dirty',
  saving: 'save.saving',
  failed: 'save.failed',
};

export function TopBar({ platform, project, save, onReveal, narrow }: TopBarProps) {
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
        title={save ? `${t('save.shortcut')} ${shortcutLabel(platform, 'S')}` : undefined}
        data-testid="save-status"
        data-state={save ?? 'none'}
      >
        {save ? <SaveStateIcon state={save} /> : <DotIcon />}
        {save ? t(SAVE_LABEL[save]) : t('topbar.saveStatus.noFile')}
      </span>
      <button
        type="button"
        className="quiet-button"
        title={t('topbar.language')}
        data-testid="switch-language"
        onClick={() => setLocale(otherLocale(locale))}
      >
        {t('topbar.switchLanguage')}
      </button>
    </header>
  );
}
