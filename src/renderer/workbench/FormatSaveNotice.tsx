import { useSyncExternalStore } from 'react';
import { useI18n } from '../i18n/I18nProvider';
import type { FormatFailure } from './format-on-save';

/** S53.4: why the last save could not format first (the file was saved as it was). Shown until dismissed. */
let failure: FormatFailure | null = null;
const listeners = new Set<() => void>();
const emit = () => {
  for (const listener of listeners) listener();
};
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

export function reportFormatOnSaveFailure(reason: FormatFailure | null): void {
  failure = reason;
  emit();
}

export function FormatSaveNotice() {
  const { t } = useI18n();
  const reason = useSyncExternalStore(subscribe, () => failure);
  if (!reason) return null;
  return (
    <span className="editor-status-hint" role="status" data-testid="format-on-save-notice" data-reason={reason}>
      {t(reason === 'timeout' ? 'formatOnSave.timeout' : 'formatOnSave.failed')}
      <button type="button" className="editor-status-hint-dismiss" onClick={() => reportFormatOnSaveFailure(null)}>
        {t('formatOnSave.dismiss')}
      </button>
    </span>
  );
}
