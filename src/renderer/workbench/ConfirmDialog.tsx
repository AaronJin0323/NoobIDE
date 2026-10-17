import { isImeKey } from './ime';
import { useEffect, useId, useRef, type ReactNode } from 'react';

interface ConfirmDialogProps {
  title: string;
  children: ReactNode;
  confirmLabel: string;
  cancelLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
  testId?: string;
}

/**
 * Small modal confirmation (S08.3). Focus starts on Cancel, so pressing Enter by habit never deletes anything;
 * Tab stays inside the dialog and Escape cancels. The caller returns focus to where it was.
 */
export function ConfirmDialog({
  title,
  children,
  confirmLabel,
  cancelLabel,
  onConfirm,
  onCancel,
  testId,
}: ConfirmDialogProps) {
  const titleId = useId();
  const bodyId = useId();
  const cancel = useRef<HTMLButtonElement>(null);
  const confirm = useRef<HTMLButtonElement>(null);

  useEffect(() => cancel.current?.focus(), []);

  return (
    <div className="dialog-backdrop" onMouseDown={onCancel}>
      <div
        className="dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={bodyId}
        data-testid={testId}
        onMouseDown={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (isImeKey(event.nativeEvent)) return;
          if (event.key === 'Escape') {
            event.preventDefault();
            onCancel();
          } else if (event.key === 'Tab') {
            // Two buttons: Tab and Shift+Tab move between them and never leave the dialog.
            event.preventDefault();
            (document.activeElement === cancel.current ? confirm : cancel).current?.focus();
          }
        }}
      >
        <h2 className="dialog-title" id={titleId}>
          {title}
        </h2>
        <div className="dialog-body" id={bodyId}>
          {children}
        </div>
        <div className="dialog-actions">
          <button type="button" className="quiet-button dialog-button" ref={cancel} onClick={onCancel}>
            {cancelLabel}
          </button>
          <button
            type="button"
            className="primary-button dialog-button"
            ref={confirm}
            data-testid="confirm-button"
            onClick={onConfirm}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
