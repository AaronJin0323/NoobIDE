import { useI18n } from '../i18n/I18nProvider';
import type { OpenTab } from './document-state';
import { saveStatus } from './save-machine';
import { WarningIcon } from './icons';

/** What the user can do about a file that changed or vanished outside NoobIDE (S11.1–S11.3). */
export interface DiskActions {
  dismissNotice(relPath: string): void;
  /** S11.2: write the buffer over the disk version that was compared. */
  keepMine(relPath: string): Promise<void>;
  /** S11.2: replace the buffer with the disk version (one undoable edit). */
  takeDisk(relPath: string): Promise<void>;
  /** S11.3: create the deleted file again with the buffer's text. */
  resave(relPath: string): Promise<void>;
  askCloseDeleted(relPath: string): void;
  cancelCloseDeleted(): void;
  closeDeleted(relPath: string): void;
}

interface DiskStateBannerProps {
  tab: OpenTab;
  actions: DiskActions;
  /** The deleted file's tab is waiting for "close without keeping" to be confirmed. */
  confirmClose: boolean;
  comparing: boolean;
  onToggleCompare(): void;
  onSaveCopy: (() => void) | undefined;
  onCloseDiscarding: (() => void) | undefined;
}

/**
 * The editor's explanation of a file's disk state. Nothing here ever happens automatically: a conflict is resolved
 * only by the user's choice after an offered comparison, and a deleted file's text stays until the user re-saves it,
 * saves it elsewhere or confirms closing it. States are written out next to a warning icon, never colour alone.
 */
export function DiskStateBanner(props: DiskStateBannerProps) {
  const { tab, actions, confirmClose, comparing } = props;
  const { t } = useI18n();
  const status = saveStatus(tab.save);
  const closeWindow = props.onCloseDiscarding && (
    <button type="button" className="secondary-button" data-testid="close-discarding" onClick={props.onCloseDiscarding}>
      {t('save.closeDiscarding')}
    </button>
  );

  if (status === 'conflict') {
    const ready = tab.conflictDisk !== undefined;
    return (
      <div className="inline-alert save-alert" role="alert" data-testid="conflict-banner">
        <WarningIcon size={15} />
        <div className="save-alert-body">
          <strong>
            {tab.relPath}: {t('conflict.title')}
          </strong>{' '}
          {t('conflict.explain')}
          <span className="alert-actions">
            <button
              type="button"
              className="secondary-button"
              data-testid="conflict-compare"
              aria-pressed={comparing}
              disabled={!ready}
              onClick={props.onToggleCompare}
            >
              {comparing ? t('conflict.hideCompare') : t('conflict.compare')}
            </button>
            <button
              type="button"
              className="secondary-button"
              data-testid="conflict-keep-mine"
              disabled={!ready}
              onClick={() => void actions.keepMine(tab.relPath)}
            >
              {t('conflict.keepMine')}
            </button>
            <button
              type="button"
              className="secondary-button"
              data-testid="conflict-take-disk"
              disabled={!ready}
              onClick={() => void actions.takeDisk(tab.relPath)}
            >
              {t('conflict.takeDisk')}
            </button>
            {closeWindow}
          </span>
          {!ready && <span className="alert-detail">{t('conflict.loading')}</span>}
          <span className="alert-detail">{t('conflict.undoHint')}</span>
        </div>
      </div>
    );
  }

  if (status === 'deleted') {
    const error = tab.save.error;
    return (
      <div className="inline-alert save-alert" role="alert" data-testid="deleted-banner">
        <WarningIcon size={15} />
        <div className="save-alert-body">
          <strong>
            {tab.relPath}: {t('deleted.title')}
          </strong>{' '}
          {t('deleted.explain')}
          {error && (
            <span className="alert-detail" data-testid="deleted-error">
              {t('deleted.resaveFailed')} {t('error.detail')}: {error.message}
            </span>
          )}
          <span className="alert-actions">
            <button
              type="button"
              className="secondary-button"
              data-testid="deleted-resave"
              onClick={() => void actions.resave(tab.relPath)}
            >
              {t('deleted.resave')}
            </button>
            {props.onSaveCopy && (
              <button type="button" className="secondary-button" data-testid="save-copy" onClick={props.onSaveCopy}>
                {t('save.elsewhere')}
              </button>
            )}
            {confirmClose ? (
              <>
                <button
                  type="button"
                  className="quiet-button danger-button"
                  data-testid="deleted-close-confirm"
                  onClick={() => actions.closeDeleted(tab.relPath)}
                >
                  {t('deleted.closeConfirm')}
                </button>
                <button type="button" className="quiet-button" onClick={actions.cancelCloseDeleted}>
                  {t('recovery.cancel')}
                </button>
              </>
            ) : (
              <button
                type="button"
                className="quiet-button"
                data-testid="deleted-close"
                onClick={() => actions.askCloseDeleted(tab.relPath)}
              >
                {t('deleted.close')}
              </button>
            )}
            {closeWindow}
          </span>
        </div>
      </div>
    );
  }

  if (tab.diskNotice === 'reloaded') {
    return (
      <p className="inline-alert" role="status" data-testid="disk-reloaded">
        <WarningIcon />
        <span>
          {tab.relPath}: {t('disk.reloaded')}
        </span>
        <button
          type="button"
          className="quiet-button"
          data-testid="disk-reloaded-dismiss"
          onClick={() => actions.dismissNotice(tab.relPath)}
        >
          {t('disk.dismiss')}
        </button>
      </p>
    );
  }
  return null;
}
