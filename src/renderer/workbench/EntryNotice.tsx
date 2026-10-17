import { useI18n } from '../i18n/I18nProvider';
import { fill } from './file-op-messages';
import { Notice } from './Notice';

export interface EntryNoticeState {
  readonly relPath: string;
  readonly error: 'failed' | 'invalid-existing' | null;
}

/**
 * S13.2: the result of "set as entry page" — what was stored and where, or why nothing was changed. S50.2: on the
 * shared Notice; the confirmation is a success (no danger fill, no timer), a failure is an alert.
 */
export function EntryNotice({ state, onDismiss }: { state: EntryNoticeState; onDismiss(): void }) {
  const { t } = useI18n();
  const dismiss = (
    <button type="button" className="secondary-button" data-testid="entry-notice-dismiss" onClick={onDismiss}>
      {t('disk.dismiss')}
    </button>
  );
  if (state.error === null) {
    return (
      <Notice
        tone="success"
        role="status"
        testId="entry-notice"
        dataState="set"
        title={fill(t('notice.entry.title'), { file: state.relPath })}
        body={t('notice.entry.body')}
        details={t('notice.entry.detail')}
        detailsLabel={t('notice.details')}
        actions={dismiss}
      />
    );
  }
  const invalid = state.error === 'invalid-existing';
  return (
    <Notice
      tone="danger"
      role="alert"
      testId="entry-notice"
      dataState={state.error}
      title={t(invalid ? 'notice.entry.invalidTitle' : 'notice.entry.failedTitle')}
      body={invalid ? t('notice.entry.invalidBody') : undefined}
      actions={dismiss}
    />
  );
}
