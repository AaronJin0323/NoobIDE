import { useI18n } from '../i18n/I18nProvider';
import { WarningIcon } from './icons';

export interface EntryNoticeState {
  readonly relPath: string;
  readonly error: 'failed' | 'invalid-existing' | null;
}

/** S13.2: the result of "set as entry page" — what was stored and where, or why nothing was changed. */
export function EntryNotice({ state, onDismiss }: { state: EntryNoticeState; onDismiss(): void }) {
  const { t } = useI18n();
  return (
    <div
      className="inline-alert save-alert app-notice"
      role={state.error ? 'alert' : 'status'}
      data-testid="entry-notice"
      data-state={state.error ?? 'set'}
    >
      {state.error && <WarningIcon size={15} />}
      <div className="save-alert-body">
        {state.error ? (
          <strong>{t(state.error === 'invalid-existing' ? 'entry.invalidExisting' : 'entry.failed')}</strong>
        ) : (
          <>
            <strong>
              {t('entry.set')} {state.relPath}
            </strong>{' '}
            {t('entry.setDetail')}
          </>
        )}
        <span className="alert-actions">
          <button type="button" className="secondary-button" data-testid="entry-notice-dismiss" onClick={onDismiss}>
            {t('disk.dismiss')}
          </button>
        </span>
      </div>
    </div>
  );
}
