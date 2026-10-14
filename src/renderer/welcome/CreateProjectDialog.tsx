import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type {
  CreateProjectApi,
  CreatedProject,
  ProjectLocation,
  TemplateSummary,
} from '../../shared/ipc/create-contract';
import { useI18n } from '../i18n/I18nProvider';
import { useModalKeys } from '../workbench/focus-trap';
import { WarningIcon } from '../workbench/icons';
import { createErrorMessage, topLevelEntries, wizardView, type NameCheck } from './welcome-model';
import './welcome.css';

interface CreateProjectDialogProps {
  api: CreateProjectApi;
  onCreated(created: CreatedProject): void;
  onCancel(): void;
}

/** Wait after typing before asking main whether the name is free. */
const CHECK_DELAY_MS = 200;

/**
 * "Create my first webpage" (S20.2, wireframe welcome 1b): one step with a template, a name and a location. The
 * picture of the selected template and the exact folder and files that will be created are shown before anything
 * is written. A name that exists (or differs only in case) keeps "Create and open" disabled with an explanation —
 * existing folders are never overwritten. Modal: focus stays inside, Escape cancels.
 */
export function CreateProjectDialog({ api, onCreated, onCancel }: CreateProjectDialogProps) {
  const { t, locale } = useI18n();
  const titleId = useId();
  const nameId = useId();
  const nameHintId = useId();
  const messageId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const [templates, setTemplates] = useState<readonly TemplateSummary[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [templateId, setTemplateId] = useState<string | null>(null);
  const [name, setName] = useState(() => t('wizard.defaultName'));
  const [location, setLocation] = useState<ProjectLocation | null>(null);
  const [check, setCheck] = useState<NameCheck>({ state: 'idle' });
  const [creating, setCreating] = useState(false);
  const checkSeq = useRef(0);

  // Templates and the default location (once, in the interface language at that moment).
  const initialLocale = useRef(locale);
  useEffect(() => {
    let cancelled = false;
    void api.options({ locale: initialLocale.current }).then((result) => {
      if (cancelled) return;
      if (!result.ok) {
        setLoadError(createErrorMessage(t, result.code, result.message, ''));
        return;
      }
      setTemplates(result.value.templates);
      setTemplateId((result.value.templates.find((tpl) => tpl.default) ?? result.value.templates[0])?.id ?? null);
      setLocation(result.value.location);
    });
    return () => {
      cancelled = true;
    };
    // Loaded once per dialog: `t` is deliberately not a dependency (a language switch must not reset the choice).
  }, [api]);

  useEffect(() => {
    nameRef.current?.focus();
    nameRef.current?.select();
  }, []);

  // Live check in main: is "<location>/<name>" free? Stale answers (older name or location) are ignored.
  useEffect(() => {
    checkSeq.current += 1;
    const seq = checkSeq.current;
    if (!location) {
      setCheck({ state: 'idle' });
      return undefined;
    }
    setCheck({ state: 'checking' });
    const timer = setTimeout(() => {
      void api.check({ locationId: location.locationId, name }).then((result) => {
        if (seq !== checkSeq.current) return;
        setCheck(
          result.ok
            ? { state: 'ok', folderPath: result.value.folderPath }
            : { state: 'error', code: result.code, message: result.message },
        );
      });
    }, CHECK_DELAY_MS);
    return () => clearTimeout(timer);
  }, [api, location, name]);

  // While main creates the project, the wizard stays open: it must adopt the result.
  useModalKeys(dialogRef, () => {
    if (!creating) onCancel();
  });

  const view = wizardView(t, { templateId, name, hasLocation: location !== null, check, creating });
  const selected = templates?.find((tpl) => tpl.id === templateId) ?? null;

  const chooseLocation = useCallback(async () => {
    const result = await api.chooseLocation();
    if (result.ok && result.value) setLocation(result.value);
  }, [api]);

  const create = useCallback(async () => {
    if (!view.canCreate || !location || !templateId) return;
    setCreating(true);
    try {
      const result = await api.create({ locationId: location.locationId, name, templateId });
      if (result.ok) {
        onCreated(result.value);
        return;
      }
      checkSeq.current += 1; // a check still running must not hide this failure
      setCheck({ state: 'error', code: result.code, message: result.message });
    } finally {
      setCreating(false);
    }
  }, [api, location, name, templateId, view.canCreate, onCreated]);

  return (
    <div className="dialog-backdrop wizard-backdrop">
      <div
        ref={dialogRef}
        className="dialog wizard"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        data-testid="create-wizard"
      >
        <h2 className="dialog-title" id={titleId}>
          {t('wizard.title')}
        </h2>
        {loadError && (
          <p className="inline-alert" role="alert" data-testid="wizard-load-error">
            <WarningIcon />
            {loadError}
          </p>
        )}
        <div className="wizard-body">
          <div className="wizard-form">
            <fieldset className="wizard-step">
              <legend className="wizard-label">{t('wizard.step.template')}</legend>
              {!templates && !loadError && <p className="placeholder">{t('wizard.loading')}</p>}
              <div className="wizard-templates" data-testid="wizard-templates">
                {templates?.map((tpl) => {
                  const checked = tpl.id === templateId;
                  return (
                    <label
                      key={tpl.id}
                      className={checked ? 'wizard-template selected' : 'wizard-template'}
                      data-testid="wizard-template"
                      data-template={tpl.id}
                    >
                      <input
                        type="radio"
                        name="wizard-template"
                        className="sr-only"
                        value={tpl.id}
                        checked={checked}
                        onChange={() => setTemplateId(tpl.id)}
                      />
                      {tpl.thumbnail && <img src={tpl.thumbnail} alt="" className="wizard-thumb" />}
                      <span className="wizard-template-name">{tpl.name[locale]}</span>
                      {/* Selection is said in text and a check mark, not only by the accent border. */}
                      {checked && <span className="wizard-template-state">✓ {t('wizard.selected')}</span>}
                    </label>
                  );
                })}
              </div>
            </fieldset>

            <div className="wizard-step">
              <label className="wizard-label" htmlFor={nameId}>
                {t('wizard.step.name')}
              </label>
              <input
                ref={nameRef}
                id={nameId}
                className="wizard-input"
                data-testid="wizard-name"
                value={name}
                spellCheck={false}
                aria-describedby={`${nameHintId} ${messageId}`}
                aria-invalid={view.messageKind === 'error'}
                onChange={(event) => setName(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    void create();
                  }
                }}
              />
              <p className="dialog-hint" id={nameHintId}>
                {t('wizard.nameHint')}
              </p>
            </div>

            <div className="wizard-step">
              <span className="wizard-label">{t('wizard.step.location')}</span>
              <div className="wizard-row">
                <span className="wizard-path" data-testid="wizard-location">
                  {location ? location.path : t('wizard.noLocation')}
                </span>
                <button
                  type="button"
                  className="secondary-button"
                  data-testid="wizard-change-location"
                  onClick={() => void chooseLocation()}
                >
                  {t('wizard.change')}
                </button>
              </div>
              {location?.isDefault && <p className="dialog-hint">{t('wizard.defaultLocationNote')}</p>}
            </div>

            <div id={messageId} aria-live="polite">
              {view.message && (
                <p
                  className={view.messageKind === 'error' ? 'inline-alert wizard-message' : 'dialog-hint'}
                  role={view.messageKind === 'error' ? 'alert' : undefined}
                  data-testid="wizard-message"
                  data-kind={view.messageKind}
                >
                  {view.messageKind === 'error' && <WarningIcon />}
                  {view.message}
                </p>
              )}
            </div>
          </div>

          <aside className="wizard-preview" aria-label={t('wizard.previewLabel')} data-testid="wizard-preview">
            {selected && (
              <>
                {selected.thumbnail && <img src={selected.thumbnail} alt="" className="wizard-preview-image" />}
                <p className="wizard-preview-name">{selected.name[locale]}</p>
                <p className="dialog-hint">{selected.description[locale]}</p>
              </>
            )}
            {view.folderPath && selected && (
              <div className="wizard-destination" data-testid="wizard-destination">
                <span className="dialog-hint">{t('wizard.willCreate')}</span>
                <strong className="wizard-path" data-testid="wizard-folder">
                  {view.folderPath}
                </strong>
                <span className="dialog-hint">{t('wizard.contains')}</span>
                <ul className="wizard-files" data-testid="wizard-files">
                  {topLevelEntries(selected.files).map((entry) => (
                    <li key={entry}>{entry}</li>
                  ))}
                </ul>
              </div>
            )}
          </aside>
        </div>
        <div className="dialog-actions">
          <button
            type="button"
            className="quiet-button dialog-button"
            data-testid="wizard-cancel"
            disabled={creating}
            onClick={onCancel}
          >
            {t('wizard.cancel')}
          </button>
          <button
            type="button"
            className="primary-button dialog-button"
            data-testid="wizard-create"
            disabled={!view.canCreate}
            onClick={() => void create()}
          >
            {creating ? t('wizard.creating') : t('wizard.create')}
          </button>
        </div>
      </div>
    </div>
  );
}
