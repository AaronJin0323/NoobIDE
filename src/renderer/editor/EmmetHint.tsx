import './authoring.css';
import { useI18n } from '../i18n/I18nProvider';
import { dismissEmmetHint, useEmmetHint } from './emmet-hint';

/** S53.1: after the first Emmet expansion, says what happened and names the setting that turns it off. */
export function EmmetHint() {
  const { t } = useI18n();
  const visible = useEmmetHint();
  if (!visible) return null;
  return (
    <span className="editor-status-hint" role="status" data-testid="emmet-hint">
      {t('emmet.hint')}
      <button type="button" className="editor-status-hint-dismiss" onClick={dismissEmmetHint}>
        {t('emmet.hint.dismiss')}
      </button>
    </span>
  );
}
