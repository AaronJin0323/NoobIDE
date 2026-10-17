import type { ReactNode } from 'react';
import { useI18n } from '../i18n/I18nProvider';
import { Sheet, sheetButtonClass } from './Sheet';

interface ConfirmDialogProps {
  title: string;
  children: ReactNode;
  confirmLabel: string;
  cancelLabel: string;
  /** `danger` draws the confirming verb destructive (Move to trash, Clear). */
  tone?: 'default' | 'danger' | undefined;
  onConfirm: () => void;
  onCancel: () => void;
  testId?: string;
}

/**
 * Small modal confirmation (S08.3) on the shared {@link Sheet} (S49.1): a question, Cancel → the confirming verb.
 * Focus starts on Cancel, so pressing Enter by habit never deletes anything; Tab stays inside; Escape, Close and a
 * click outside cancel (nothing typed here can be lost). The Close control is named "Close", so Cancel stays the one
 * control with its name. The caller returns focus to where it was.
 */
export function ConfirmDialog({
  title,
  children,
  confirmLabel,
  cancelLabel,
  tone = 'default',
  onConfirm,
  onCancel,
  testId,
}: ConfirmDialogProps) {
  const { t } = useI18n();
  return (
    <Sheet
      title={title}
      role="alertdialog"
      width={480}
      onClose={onCancel}
      closeLabel={t('dialog.close')}
      dismissOnBackdrop
      testId={testId ?? 'confirm-dialog'}
      closeTestId="confirm-close"
      actions={
        <>
          <button type="button" className={sheetButtonClass('cancel')} data-autofocus onClick={onCancel}>
            {cancelLabel}
          </button>
          <button
            type="button"
            className={sheetButtonClass(tone === 'danger' ? 'danger' : 'primary')}
            data-testid="confirm-button"
            onClick={onConfirm}
          >
            {confirmLabel}
          </button>
        </>
      }
    >
      <div className="dialog-body">{children}</div>
    </Sheet>
  );
}
