import { useI18n } from '../i18n/I18nProvider';
import { WarningIcon } from './icons';
import { useAutoDismiss } from './useAutoDismiss';

export interface EntryNoticeState {
  readonly relPath: string;
  readonly error: 'failed' | 'invalid-existing' | null;
}

/**
 * S13.2: the result of "set as entry page" — what was stored and where, or why nothing was changed. S47.5: the
 * success notice is information and leaves by itself; a failure waits for the user.
 */
export function EntryNotice({ state, onDismiss }: { state: EntryNoticeState; onDismiss(): void }) {
  return state.error ? (
    <EntryNoticeView state={state} onDismiss={onDismiss} />
  ) : (
    <EntryNoticeInfo state={state} onDismiss={onDismiss} />
  );
}

function EntryNoticeInfo({ state, onDismiss }: { state: EntryNoticeState; onDismiss(): void }) {
  const hold = useAutoDismiss(onDismiss);
  return <EntryNoticeView state={state} onDismiss={onDismiss} hold={hold} />;
}

function EntryNoticeView({
  state,
  onDismiss,
  hold,
}: {
  state: EntryNoticeState;
  onDismiss(): void;
  hold?: ReturnType<typeof useAutoDismiss>;
}) {
  const { t } = useI18n();
  return (
    <div
      className="inline-alert save-alert app-notice"
      role={state.error ? 'alert' : 'status'}
      data-testid="entry-notice"
      data-state={state.error ?? 'set'}
      {...hold}
    >
      {state.error && <WarningIcon size={16} />}
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
