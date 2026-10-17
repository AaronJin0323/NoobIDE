import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import type { OpenedProject } from '../../shared/ipc/contract';
import type {
  CheckpointComparison,
  CheckpointInfo,
  CheckpointListing,
  CheckpointsApi,
} from '../../shared/ipc/checkpoints-contract';
import { compareVersion } from '../history/history-model';
import { VersionDiff } from '../history/HistoryDialog';
import { useI18n } from '../i18n/I18nProvider';
import type { MessageKey } from '../i18n/index';
import { fill, formatBytes } from '../recovery/format';
import { WarningIcon } from '../workbench/icons';
import { Sheet } from '../workbench/Sheet';
import { causeKey, checkpointErrorText, restoreReportText, usageText } from './checkpoint-model';
import { planRestore, restoreFromCheckpoint, type CheckpointRestoreHost, type RestorePlan } from './checkpoint-restore';
import '../history/history.css';
import './checkpoints.css';

interface CheckpointsDialogProps {
  api: CheckpointsApi;
  project: OpenedProject;
  /** The file's current text: the editor's when open (unsaved edits included), else the disk's; null if gone. */
  currentText(relPath: string): Promise<string | null>;
  /** How a restore reaches the files (open tabs, atomic writes, trash): built by the workbench. */
  restoreHost(): CheckpointRestoreHost | null;
  onClose(): void;
}

type Notice = { readonly kind: 'ok' | 'error'; readonly text: string; readonly details?: readonly string[] };

/** What the compare pane shows for the chosen file. */
type FileView =
  | { readonly relPath: string; readonly mode: 'diff'; readonly current: string | null; readonly checkpoint: string }
  | { readonly relPath: string; readonly mode: 'added' | 'not-text' | 'unavailable' };

const STATUS_KEY: Record<'added' | 'changed' | 'removed', MessageKey> = {
  added: 'checkpoints.status.added',
  changed: 'checkpoints.status.changed',
  removed: 'checkpoints.status.removed',
};
/** Text marks next to the status words (state is never shown by colour alone). */
const STATUS_MARK: Record<'added' | 'changed' | 'removed', string> = { added: '+', changed: '~', removed: '−' };

/**
 * Project checkpoints (S56.2): save a named checkpoint of the whole project, list, rename and delete them, compare
 * one with the project now (file by file, and the diff of any file) and restore everything or one file. A restore
 * asks first what to do with unsaved edits and whether files added since go to the trash (unticked by default).
 * Separate from the local-history window (per-file versions) and from undo. Modal: focus stays inside, Escape closes.
 */
export function CheckpointsDialog(props: CheckpointsDialogProps) {
  const { api, project, currentText, restoreHost, onClose } = props;
  const { t, locale } = useI18n();
  const nameId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const [listing, setListing] = useState<CheckpointListing | null>(null);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [comparison, setComparison] = useState<CheckpointComparison | null>(null);
  const [fileView, setFileView] = useState<FileView | null>(null);
  const [restore, setRestore] = useState<{
    plan: RestorePlan;
    only: string | null;
    unsaved: 'save' | 'keep';
    trashAdded: boolean;
  } | null>(null);
  const choice = useRef(0);
  const time = useMemo(() => new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'medium' }), [locale]);
  const projectId = project.projectId;

  const load = useCallback(async () => {
    const result = await api.list({ projectId });
    if (result.ok) setListing(result.value);
    else {
      setListing({ checkpoints: [], damaged: [], usage: emptyUsage });
      setNotice({ kind: 'error', text: checkpointErrorText(t, result.code) });
    }
  }, [api, projectId, t]);

  useEffect(() => {
    void load();
    // Loaded once when the window opens; later loads follow each change.
  }, []);

  useEffect(() => {
    dialogRef.current?.querySelector<HTMLElement>('[data-autofocus]')?.focus();
  }, []);

  const save = async () => {
    setBusy(true);
    setNotice(null);
    try {
      const result = await api.create({ projectId, name, kind: 'named', cause: 'manual' });
      if (result.ok) {
        const files = result.value.checkpoint.fileCount;
        setNotice({
          kind: 'ok',
          text: fill(t('checkpoints.saved', files), { name: result.value.checkpoint.name, files }),
        });
        setName('');
      } else setNotice({ kind: 'error', text: checkpointErrorText(t, result.code, result.detail) });
      await load();
    } finally {
      setBusy(false);
    }
  };

  const saveRename = async () => {
    if (!renaming) return;
    setBusy(true);
    try {
      const result = await api.rename({ projectId, id: renaming.id, name: renaming.name });
      setNotice(
        result.ok
          ? { kind: 'ok', text: t('checkpoints.renamed') }
          : { kind: 'error', text: checkpointErrorText(t, result.code, result.detail) },
      );
      if (result.ok) setRenaming(null);
      await load();
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: string) => {
    setConfirmDelete(null);
    setBusy(true);
    try {
      const result = await api.delete({ projectId, id });
      setNotice(
        result.ok
          ? { kind: 'ok', text: t('checkpoints.deleted') }
          : { kind: 'error', text: checkpointErrorText(t, result.code) },
      );
      if (comparison?.checkpoint.id === id) {
        setComparison(null);
        setFileView(null);
      }
      await load();
    } finally {
      setBusy(false);
    }
  };

  const compare = async (checkpoint: CheckpointInfo) => {
    choice.current += 1;
    const mine = choice.current;
    setNotice(null);
    setRestore(null);
    setFileView(null);
    const result = await api.compare({ projectId, id: checkpoint.id });
    if (mine !== choice.current) return;
    if (!result.ok) {
      setComparison(null);
      setNotice({ kind: 'error', text: checkpointErrorText(t, result.code) });
      return;
    }
    setComparison(result.value);
  };

  const chooseFile = async (relPath: string) => {
    if (!comparison) return;
    const entry = comparison.entries.find((e) => e.relPath === relPath);
    if (!entry) return;
    choice.current += 1;
    const mine = choice.current;
    setRestore(null);
    if (entry.status === 'added') return setFileView({ relPath, mode: 'added' });
    if (!entry.available) return setFileView({ relPath, mode: 'unavailable' });
    const [text, current] = await Promise.all([
      api.readText({ projectId, id: comparison.checkpoint.id, relPath }),
      entry.status === 'removed' ? Promise.resolve(null) : currentText(relPath).catch(() => null),
    ]);
    if (mine !== choice.current) return;
    if (!text.ok) {
      setFileView({ relPath, mode: text.code === 'not-text' ? 'not-text' : 'unavailable' });
      return;
    }
    setFileView({ relPath, mode: 'diff', current, checkpoint: text.value.text });
  };

  const askRestore = (only: string | null) => {
    const host = restoreHost();
    if (!comparison || !host) return;
    setNotice(null);
    setRestore({
      plan: planRestore(comparison, host.openTab, only ?? undefined),
      only,
      unsaved: 'save',
      trashAdded: false,
    });
  };

  const runRestore = async () => {
    const host = restoreHost();
    if (!restore || !comparison || !host) return;
    setBusy(true);
    try {
      const report = await restoreFromCheckpoint(
        host,
        restore.plan,
        { unsaved: restore.unsaved, trashAdded: restore.trashAdded },
        fill(t('checkpoints.safetyName'), { name: comparison.checkpoint.name }),
      );
      const text = restoreReportText(t, report);
      setNotice({ kind: text.ok ? 'ok' : 'error', text: text.summary, details: text.details });
      setRestore(null);
      setFileView(null);
      await load();
      const again = await api.compare({ projectId, id: comparison.checkpoint.id });
      if (again.ok) setComparison(again.value);
    } catch {
      setNotice({ kind: 'error', text: t('checkpoints.error.generic') });
    } finally {
      setBusy(false);
    }
  };

  // Escape first backs out of a staged restore, rename or delete confirmation; with nothing staged it closes (the
  // sheet's own Close). While a change runs, the sheet disables both so the result stays visible.
  const staged = restore !== null || confirmDelete !== null || renaming !== null;
  const cancelStaged = () => {
    if (restore) setRestore(null);
    else {
      setConfirmDelete(null);
      setRenaming(null);
    }
  };

  const changed = comparison?.entries.filter((e) => e.status !== 'same') ?? [];
  const same = (comparison?.entries.length ?? 0) - changed.length;
  const usage = listing ? usageText(t, listing.usage) : null;
  const diff = fileView?.mode === 'diff' ? compareVersion(fileView.current, fileView.checkpoint) : null;

  return (
    <Sheet
      title={t('checkpoints.title')}
      width={960}
      className="history-dialog checkpoints-dialog"
      backdropClassName="history-backdrop"
      sheetRef={dialogRef}
      onClose={onClose}
      closeDisabled={busy}
      onEscape={staged ? cancelStaged : undefined}
      closeLabel={t('checkpoints.close')}
      testId="checkpoints-dialog"
      closeTestId="checkpoints-close"
    >
      <p className="dialog-hint history-intro" data-testid="checkpoints-intro">
        {t('checkpoints.intro')}
      </p>
      {notice && (
        <div
          className={notice.kind === 'error' ? 'inline-alert history-notice' : 'history-notice history-ok'}
          role={notice.kind === 'error' ? 'alert' : 'status'}
          data-testid="checkpoints-notice"
          data-kind={notice.kind}
        >
          {notice.kind === 'error' && <WarningIcon />}
          <span>
            {notice.text}
            {notice.details && notice.details.length > 0 && (
              <ul className="checkpoints-details">
                {notice.details.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            )}
          </span>
        </div>
      )}

      <form
        className="checkpoints-new"
        onSubmit={(e) => {
          e.preventDefault();
          if (!busy && name.trim() !== '') void save();
        }}
      >
        <label htmlFor={nameId}>{t('checkpoints.nameLabel')}</label>
        <input
          id={nameId}
          type="text"
          className="name-input"
          data-testid="checkpoints-name"
          data-autofocus
          maxLength={80}
          value={name}
          placeholder={t('checkpoints.namePlaceholder')}
          onChange={(e) => setName(e.target.value)}
          disabled={busy}
        />
        <button
          type="submit"
          className="primary-button"
          data-testid="checkpoints-save"
          disabled={busy || name.trim() === ''}
        >
          {busy ? t('checkpoints.saving') : t('checkpoints.save')}
        </button>
      </form>

      <div className="history-columns checkpoints-columns">
        <section className="history-column" aria-label={t('checkpoints.list')}>
          <h3 className="history-column-title">{t('checkpoints.list')}</h3>
          {listing && listing.checkpoints.length === 0 && <p className="dialog-hint">{t('checkpoints.empty')}</p>}
          <ul className="history-list" data-testid="checkpoints-list">
            {listing?.checkpoints.map((c) => (
              <li
                key={c.id}
                className="checkpoint-item"
                data-testid="checkpoint"
                data-id={c.id}
                data-kind={c.kind}
                data-cause={c.cause}
              >
                {renaming?.id === c.id ? (
                  <form
                    className="checkpoint-rename"
                    onSubmit={(e) => {
                      e.preventDefault();
                      void saveRename();
                    }}
                  >
                    <input
                      type="text"
                      className="name-input"
                      aria-label={t('checkpoints.renameLabel')}
                      data-testid="checkpoint-rename-input"
                      maxLength={80}
                      value={renaming.name}
                      onChange={(e) => setRenaming({ id: c.id, name: e.target.value })}
                      autoFocus
                    />
                    <button
                      type="submit"
                      className="secondary-button"
                      data-testid="checkpoint-rename-save"
                      disabled={busy}
                    >
                      {t('checkpoints.renameSave')}
                    </button>
                    <button type="button" className="quiet-button" onClick={() => setRenaming(null)}>
                      {t('checkpoints.cancel')}
                    </button>
                  </form>
                ) : (
                  <>
                    <button
                      type="button"
                      className="history-item"
                      aria-current={comparison?.checkpoint.id === c.id}
                      aria-label={fill(t('checkpoints.compareLabel'), { name: c.name })}
                      data-testid="checkpoint-compare"
                      disabled={busy}
                      onClick={() => void compare(c)}
                    >
                      <span className="history-item-main" data-testid="checkpoint-name">
                        {c.name}
                      </span>
                      <span className="history-item-detail">
                        <span className="history-tag" data-testid="checkpoint-kind">
                          {t(c.kind === 'named' ? 'checkpoints.kind.named' : 'checkpoints.kind.auto')}
                        </span>{' '}
                        {time.format(c.createdAt)} · {t(causeKey(c.cause))}
                      </span>
                      <span className="history-item-detail">
                        {fill(t('checkpoints.detail'), { files: c.fileCount, size: formatBytes(c.bytes) })}
                      </span>
                    </button>
                    {confirmDelete === c.id ? (
                      <span className="alert-actions" role="alert">
                        <span>{fill(t('checkpoints.deleteConfirm'), { name: c.name })}</span>
                        <button
                          type="button"
                          className="secondary-button"
                          autoFocus
                          onClick={() => setConfirmDelete(null)}
                        >
                          {t('checkpoints.cancel')}
                        </button>
                        <button
                          type="button"
                          className="secondary-button danger-button"
                          data-testid="checkpoint-delete-confirm"
                          disabled={busy}
                          onClick={() => void remove(c.id)}
                        >
                          {t('checkpoints.deleteYes')}
                        </button>
                      </span>
                    ) : (
                      <span className="checkpoint-actions">
                        <button
                          type="button"
                          className="quiet-button"
                          data-testid="checkpoint-rename"
                          disabled={busy}
                          onClick={() => setRenaming({ id: c.id, name: c.name })}
                        >
                          {t('checkpoints.rename')}
                        </button>
                        <button
                          type="button"
                          className="quiet-button"
                          data-testid="checkpoint-delete"
                          disabled={busy}
                          onClick={() => setConfirmDelete(c.id)}
                        >
                          {t('checkpoints.delete')}
                        </button>
                      </span>
                    )}
                  </>
                )}
              </li>
            ))}
          </ul>
          {listing && listing.damaged.length > 0 && (
            <div className="checkpoints-damaged" data-testid="checkpoints-damaged">
              <p className="dialog-hint">
                <WarningIcon size={14} />{' '}
                {fill(t('checkpoints.damaged', listing.damaged.length), { n: listing.damaged.length })}
              </p>
              <ul className="history-list">
                {listing.damaged.map((d) => (
                  <li key={d.id} className="checkpoint-item">
                    <span className="history-item-detail">
                      {fill(t('checkpoints.damagedItem'), { when: time.format(Number(d.id.split('-')[0])) })}
                    </span>
                    {confirmDelete === d.id ? (
                      <span className="alert-actions" role="alert">
                        <span>
                          {fill(t('checkpoints.deleteConfirm'), {
                            name: fill(t('checkpoints.damagedItem'), {
                              when: time.format(Number(d.id.split('-')[0])),
                            }),
                          })}
                        </span>
                        <button
                          type="button"
                          className="secondary-button"
                          autoFocus
                          onClick={() => setConfirmDelete(null)}
                        >
                          {t('checkpoints.cancel')}
                        </button>
                        <button
                          type="button"
                          className="secondary-button danger-button"
                          data-testid="checkpoint-damaged-delete-confirm"
                          disabled={busy}
                          onClick={() => void remove(d.id)}
                        >
                          {t('checkpoints.deleteYes')}
                        </button>
                      </span>
                    ) : (
                      <button
                        type="button"
                        className="quiet-button"
                        data-testid="checkpoint-damaged-delete"
                        disabled={busy}
                        onClick={() => setConfirmDelete(d.id)}
                      >
                        {t('checkpoints.delete')}
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </section>

        <section
          className="history-column"
          aria-label={
            comparison ? fill(t('checkpoints.compareTitle'), { name: comparison.checkpoint.name }) : undefined
          }
          data-testid="checkpoints-compare"
        >
          {comparison && (
            <>
              <h3 className="history-column-title">
                {fill(t('checkpoints.compareTitle'), { name: comparison.checkpoint.name })}
              </h3>
              {comparison.incomplete && <p className="dialog-hint">{t('checkpoints.incomplete')}</p>}
              {changed.length === 0 ? (
                <p className="dialog-hint" data-testid="checkpoints-no-changes">
                  {t('checkpoints.noChanges')}
                </p>
              ) : (
                <ul className="history-list" data-testid="checkpoints-entries">
                  {changed.map((e) => {
                    const status = e.status as 'added' | 'changed' | 'removed';
                    return (
                      <li key={e.relPath}>
                        <button
                          type="button"
                          className="history-item"
                          aria-current={fileView?.relPath === e.relPath}
                          data-testid="checkpoint-entry"
                          data-path={e.relPath}
                          data-status={status}
                          disabled={busy}
                          onClick={() => void chooseFile(e.relPath)}
                        >
                          <span className="history-item-main">{e.relPath}</span>
                          <span className={`history-tag checkpoint-status checkpoint-${status}`}>
                            <span aria-hidden="true">{STATUS_MARK[status]}</span> {t(STATUS_KEY[status])}
                          </span>
                          {!e.available && (
                            <span className="history-tag" data-testid="checkpoint-unavailable">
                              <WarningIcon size={14} />
                              {t('checkpoints.unavailableFile')}
                            </span>
                          )}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
              {same > 0 && <p className="dialog-hint">{fill(t('checkpoints.unchanged', same), { n: same })}</p>}
              {changed.length > 0 && !restore && (
                <div className="history-actions">
                  <button
                    type="button"
                    className="primary-button"
                    data-testid="checkpoints-restore-all"
                    disabled={busy}
                    onClick={() => askRestore(null)}
                  >
                    {t('checkpoints.restoreAll')}
                  </button>
                </div>
              )}
            </>
          )}
        </section>

        <section className="history-column history-compare" data-testid="checkpoints-file">
          {comparison && changed.length > 0 && !fileView && !restore && (
            <p className="dialog-hint">{t('checkpoints.pickFile')}</p>
          )}
          {fileView?.mode === 'added' && <p className="dialog-hint">{t('checkpoints.addedNote')}</p>}
          {fileView?.mode === 'not-text' && <p className="dialog-hint">{t('checkpoints.notText')}</p>}
          {fileView?.mode === 'unavailable' && (
            <p className="inline-alert">
              <WarningIcon />
              {t('checkpoints.unavailableFile')}
            </p>
          )}
          {diff?.mode === 'deleted' && (
            <>
              <p className="dialog-hint">{t('checkpoints.removedNote')}</p>
              <pre className="diff-lines history-text" tabIndex={0}>
                {diff.text}
              </pre>
            </>
          )}
          {diff?.mode === 'diff' && <VersionDiff diff={diff.diff} />}
          {fileView && fileView.mode !== 'added' && fileView.mode !== 'unavailable' && !restore && (
            <div className="history-restore">
              <button
                type="button"
                className="secondary-button"
                data-testid="checkpoints-restore-file"
                disabled={busy}
                onClick={() => askRestore(fileView.relPath)}
              >
                {t('checkpoints.restoreFile')}
              </button>
            </div>
          )}
          {restore && comparison && (
            <RestorePanel
              name={comparison.checkpoint.name}
              state={restore}
              busy={busy}
              onChange={(next) => setRestore({ ...restore, ...next })}
              onCancel={() => setRestore(null)}
              onConfirm={() => void runRestore()}
            />
          )}
        </section>
      </div>

      <section className="history-storage" aria-label={t('checkpoints.storage')} data-testid="checkpoints-storage">
        {usage && (
          <>
            <p className="history-usage" data-testid="checkpoints-usage">
              {usage.usage}
            </p>
            <p className="dialog-hint">{usage.policy}</p>
          </>
        )}
      </section>
    </Sheet>
  );
}

function RestorePanel(props: {
  name: string;
  state: { plan: RestorePlan; unsaved: 'save' | 'keep'; trashAdded: boolean };
  busy: boolean;
  onChange(next: { unsaved?: 'save' | 'keep'; trashAdded?: boolean }): void;
  onCancel(): void;
  onConfirm(): void;
}) {
  const { t } = useI18n();
  const { plan, unsaved, trashAdded } = props.state;
  const groupName = useId();
  const write = plan.write.length;
  return (
    <div
      className="checkpoints-restore"
      role="group"
      aria-label={fill(t('checkpoints.restore.title'), { name: props.name })}
      data-testid="checkpoints-restore-panel"
    >
      <h3 className="history-column-title">{fill(t('checkpoints.restore.title'), { name: props.name })}</h3>
      <p>
        {write > 0 ? fill(t('checkpoints.restore.summary', write), { n: write }) : t('checkpoints.restore.nothing')}
      </p>
      <p className="dialog-hint">{t('checkpoints.restore.safety')}</p>
      {plan.unavailable.length > 0 && (
        <p className="inline-alert">
          <WarningIcon />
          {fill(t('checkpoints.restore.unavailable'), { files: plan.unavailable.map((e) => e.relPath).join(' · ') })}
        </p>
      )}
      {plan.dirty.length > 0 && (
        <fieldset className="checkpoints-choice" data-testid="checkpoints-dirty">
          <legend>
            {fill(t('checkpoints.restore.dirty'), { files: plan.dirty.join(' · ') })}{' '}
            {t('checkpoints.restore.dirtyQuestion')}
          </legend>
          <label>
            <input
              type="radio"
              name={groupName}
              data-testid="checkpoints-dirty-save"
              checked={unsaved === 'save'}
              onChange={() => props.onChange({ unsaved: 'save' })}
            />
            {t('checkpoints.restore.dirtySave')}
          </label>
          <label>
            <input
              type="radio"
              name={groupName}
              data-testid="checkpoints-dirty-keep"
              checked={unsaved === 'keep'}
              onChange={() => props.onChange({ unsaved: 'keep' })}
            />
            {t('checkpoints.restore.dirtyKeep')}
          </label>
        </fieldset>
      )}
      {plan.added.length > 0 && (
        <div className="checkpoints-choice" data-testid="checkpoints-added">
          <p>{fill(t('checkpoints.restore.added'), { files: plan.added.map((e) => e.relPath).join(' · ') })}</p>
          <label>
            <input
              type="checkbox"
              data-testid="checkpoints-trash-added"
              checked={trashAdded}
              onChange={(e) => props.onChange({ trashAdded: e.target.checked })}
            />
            {t('checkpoints.restore.trashAdded')}
          </label>
        </div>
      )}
      <span className="alert-actions">
        <button type="button" className="secondary-button" disabled={props.busy} onClick={props.onCancel}>
          {t('checkpoints.cancel')}
        </button>
        <button
          type="button"
          className="primary-button"
          data-testid="checkpoints-restore-confirm"
          disabled={props.busy || (write === 0 && !(trashAdded && plan.added.length > 0))}
          onClick={props.onConfirm}
        >
          {props.busy ? t('checkpoints.restore.running') : t('checkpoints.restore.confirm')}
        </button>
      </span>
    </div>
  );
}

const emptyUsage = {
  totalBytes: 0,
  projectBytes: 0,
  maxTotalBytes: 0,
  named: 0,
  automatic: 0,
  maxNamed: 0,
  maxAuto: 0,
  maxAutoAgeDays: 0,
  maxFiles: 0,
  maxFileBytes: 0,
} as const;
