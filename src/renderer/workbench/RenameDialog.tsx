import { useEffect, useId, useRef, useState } from 'react';
import { useI18n } from '../i18n/I18nProvider';
import type { MessageKey } from '../i18n/index';
import { fill } from '../recovery/format';
import { Sheet, sheetButtonClass } from './Sheet';
import type { RenamePlan } from '../editor/js-navigation';
import type { RenameOutcome } from './rename-apply';

type Step =
  | { readonly kind: 'input'; readonly error: MessageKey | null; readonly detail: string }
  | { readonly kind: 'preview'; readonly plan: Extract<RenamePlan, { ok: true }> }
  | { readonly kind: 'result'; readonly outcome: RenameOutcome };

/**
 * S57.2: rename across the project's scripts, on the shared {@link Sheet} (S49.1). The new name, then a preview of
 * every file's changed lines (before and after, labelled in text), then — only on Apply — the change goes through the
 * save pipeline, and the result says per file what happened. A refusal says why and changes nothing.
 */
export function RenameDialog({
  name,
  plan,
  apply,
  onClose,
}: {
  name: string;
  /** Computes the checked plan for a new name. */
  plan: (newName: string) => Promise<RenamePlan | null>;
  apply: (plan: Extract<RenamePlan, { ok: true }>) => Promise<RenameOutcome>;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const formId = useId();
  const input = useRef<HTMLInputElement>(null);
  const primary = useRef<HTMLButtonElement>(null);
  const [newName, setNewName] = useState(name);
  const [step, setStep] = useState<Step>({ kind: 'input', error: null, detail: '' });
  const [busy, setBusy] = useState(false);
  // While the rename is being applied the sheet stays (Close and Escape are disabled): its result says what happened
  // to each file.
  const close = () => {
    if (!busy) onClose();
  };
  useEffect(() => {
    if (step.kind === 'input') {
      input.current?.focus();
      input.current?.select();
    } else primary.current?.focus();
  }, [step.kind]);

  const preview = async () => {
    setBusy(true);
    const result = await plan(newName.trim()).catch(() => null);
    setBusy(false);
    if (result?.ok) setStep({ kind: 'preview', plan: result });
    else
      setStep({
        kind: 'input',
        error: `rename.refused.${result ? result.reason : 'not-renamable'}` as MessageKey,
        detail: (result && !result.ok && result.detail) || '',
      });
  };

  const run = async (chosen: Extract<RenamePlan, { ok: true }>) => {
    setBusy(true);
    try {
      setStep({ kind: 'result', outcome: await apply(chosen) });
    } catch {
      setStep({
        kind: 'result',
        outcome: { applied: false, files: chosen.files.map((f) => ({ relPath: f.relPath, status: 'unreadable' })) },
      });
    } finally {
      setBusy(false);
    }
  };

  const title =
    step.kind === 'preview'
      ? fill(t('rename.previewTitle'), {
          old: step.plan.oldName,
          new: step.plan.newName,
          files: String(step.plan.files.length),
        })
      : step.kind === 'result'
        ? t(
            !step.outcome.applied
              ? 'rename.result.refused'
              : step.outcome.files.every((f) => f.status === 'renamed')
                ? 'rename.result.ok'
                : 'rename.result.partial',
          )
        : fill(t('rename.title'), { name });

  const actions =
    step.kind === 'input' ? (
      <>
        <button type="button" className={sheetButtonClass('cancel')} onClick={close} disabled={busy}>
          {t('rename.cancel')}
        </button>
        <button
          type="submit"
          form={formId}
          className={sheetButtonClass('primary')}
          disabled={busy}
          data-testid="rename-preview"
        >
          {t('rename.preview')}
        </button>
      </>
    ) : step.kind === 'preview' ? (
      <>
        <button
          type="button"
          className={sheetButtonClass('cancel')}
          onClick={() => setStep({ kind: 'input', error: null, detail: '' })}
        >
          {t('rename.back')}
        </button>
        <button type="button" className={sheetButtonClass('cancel')} onClick={close} disabled={busy}>
          {t('rename.cancel')}
        </button>
        <button
          type="button"
          ref={primary}
          className={sheetButtonClass('primary')}
          disabled={busy}
          data-testid="rename-apply"
          onClick={() => void run(step.plan)}
        >
          {t('rename.apply')}
        </button>
      </>
    ) : (
      <button type="button" ref={primary} className={sheetButtonClass('primary')} onClick={onClose}>
        {t('rename.close')}
      </button>
    );

  return (
    <Sheet
      title={title}
      width={720}
      className="rename-dialog"
      onClose={step.kind === 'result' ? onClose : close}
      closeLabel={t(step.kind === 'result' ? 'rename.close' : 'rename.cancel')}
      closeDisabled={busy}
      testId="rename-dialog"
      closeTestId="rename-close"
      actions={actions}
    >
      <div aria-busy={busy}>
        {step.kind === 'input' && (
          <form
            id={formId}
            onSubmit={(event) => {
              event.preventDefault();
              void preview();
            }}
          >
            <div className="dialog-body">
              <label className="rename-field">
                <span>{t('rename.newName')}</span>
                <input
                  ref={input}
                  type="text"
                  spellCheck={false}
                  value={newName}
                  aria-invalid={step.error !== null}
                  data-testid="rename-input"
                  onChange={(event) => setNewName(event.target.value)}
                />
              </label>
              {step.error && (
                <p className="dialog-hint" role="alert" data-testid="rename-refused">
                  {fill(t(step.error), { name, detail: step.detail })}
                </p>
              )}
            </div>
          </form>
        )}
        {step.kind === 'preview' && (
          <div className="dialog-body rename-preview" data-testid="rename-plan">
            {step.plan.files.map((file) => (
              <section key={file.relPath} data-testid="rename-file" data-path={file.relPath}>
                <h3 className="rename-file-title">
                  {fill(t('rename.fileChanges'), { file: file.relPath, count: String(file.count) })}
                </h3>
                <ul className="rename-lines">
                  {file.lines.map((line) => (
                    <li key={line.line}>
                      <span className="rename-line-number">{fill(t('rename.line'), { line: String(line.line) })}</span>
                      <span className="rename-before">
                        <span className="rename-tag">{t('rename.before')}</span>
                        <code>{line.before.trim()}</code>
                      </span>
                      <span className="rename-after">
                        <span className="rename-tag">{t('rename.after')}</span>
                        <code>{line.after.trim()}</code>
                      </span>
                    </li>
                  ))}
                </ul>
              </section>
            ))}
            <p className="dialog-hint">{t('rename.undoHint')}</p>
          </div>
        )}
        {step.kind === 'result' && (
          <div className="dialog-body">
            <ul className="rename-results" role="status" data-testid="rename-result">
              {step.outcome.files.map((file) => (
                <li key={file.relPath} data-status={file.status}>
                  <strong>{file.relPath}</strong>
                  {`: ${t(`rename.status.${file.status}` as MessageKey)}`}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </Sheet>
  );
}
