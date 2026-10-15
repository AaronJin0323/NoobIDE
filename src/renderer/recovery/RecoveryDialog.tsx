import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { NoobideApi, OpenedProject } from '../../shared/ipc/contract';
import type {
  PendingEntry,
  PendingRecovery,
  PendingRecoveryFile,
  PendingRecoveryProject,
  RecoveredEntry,
} from '../../shared/ipc/recovery-contract';
import { useI18n } from '../i18n/I18nProvider';
import type { MessageKey } from '../i18n/index';
import { WarningIcon } from '../workbench/icons';
import { rendererPlatform } from '../workbench/file-op-messages';
import { protectedFolderKey } from '../../platform/labels';
import { fill, formatBytes } from './format';
import { diffLines } from './line-diff';
import { copyText } from '../ai/clipboard';
import type { JournalHealth } from './journal-scheduler';

/**
 * Restore prompt after an abnormal termination (S12.2) and the clear-data control (S12.3). On start it asks main
 * for journal records left by an earlier run. The user reopens the project, compares each recovered copy with the
 * file on disk and restores it into the editor (as unsaved edits) or discards it. "Decide later" keeps everything.
 * Recovered text is only ever shown in the diff and handed to the editor; it is never logged.
 *
 * Decision 0033: when the project folder cannot be opened (moved, renamed, drive not connected) the copies are shown
 * read-only with Copy, Save as… and Discard, and the user can point at the folder's new location. Main shows every
 * dialog and keeps every path; the renderer names a copy only by its journal key and buffer id.
 */
interface RecoveryDialogProps {
  bridge: NoobideApi | undefined;
  health: JournalHealth;
  /** Makes `project` the workbench's project; false when the current file could not be saved first. */
  onProjectOpened(project: OpenedProject): Promise<boolean>;
  /**
   * Loads the recovered text into the editor as unsaved edits. Never saves anything itself: when the editor holds
   * unsaved edits (e.g. a copy restored a moment ago) it returns `save-first` and the user saves or decides later.
   */
  onRestore(project: OpenedProject, entry: RecoveredEntry): Promise<RestoreOutcome>;
  /** The journal was cleared: unsaved edits still in the editor must be journaled again. */
  onCleared(): void;
}

export type RestoreOutcome = 'restored' | 'save-first' | 'failed';

interface Review {
  readonly project: OpenedProject;
  readonly files: readonly PendingRecoveryFile[];
  readonly selected: string;
  readonly entries: Readonly<Record<string, RecoveredEntry | 'failed'>>;
}

/** Decision 0033: copies of a project whose folder could not be opened, read without opening it. */
interface OrphanReview {
  readonly project: PendingRecoveryProject;
  readonly files: readonly PendingRecoveryFile[];
  readonly selected: string;
  readonly entries: Readonly<Record<string, PendingEntry | 'failed'>>;
  /** The chosen folder lacks some recovered files: main holds the folder under `choiceId` until the user confirms. */
  readonly confirm: {
    readonly choiceId: string;
    readonly folderName: string;
    readonly missing: readonly string[];
  } | null;
}

interface Notice {
  readonly key: MessageKey;
  readonly vars?: Readonly<Record<string, string | number>>;
}

export function RecoveryDialog({ bridge, health, onProjectOpened, onRestore, onCleared }: RecoveryDialogProps) {
  const { t, locale } = useI18n();
  const [pending, setPending] = useState<PendingRecovery | null>(null);
  const [open, setOpen] = useState(false);
  const [review, setReview] = useState<Review | null>(null);
  const [orphan, setOrphan] = useState<OrphanReview | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [error, setError] = useState<MessageKey | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    void bridge?.recovery.listPending().then((result) => {
      if (cancelled || !result.ok || result.value.projects.length === 0) return;
      setPending(result.value);
      setOpen(true);
    });
    return () => {
      cancelled = true;
    };
  }, [bridge]);

  // Keyboard users land in the dialog when it opens and when it switches between the list and a review step.
  const step = review !== null ? 'review' : orphan !== null ? `orphan:${orphan.project.key}` : 'list';
  useEffect(() => {
    if (open) dialogRef.current?.querySelector<HTMLElement>('button')?.focus();
  }, [open, step]);

  const close = useCallback(() => {
    setOpen(false);
    setConfirmClear(false);
  }, []);

  const requested = useRef(new Set<string>());
  const loadEntry = useCallback(
    async (project: OpenedProject, file: PendingRecoveryFile) => {
      if (!bridge || requested.current.has(file.bufferId)) return;
      requested.current.add(file.bufferId);
      const result = await bridge.recovery.read({
        projectId: project.projectId,
        relPath: file.relPath,
        bufferId: file.bufferId,
      });
      setReview((r) =>
        r ? { ...r, entries: { ...r.entries, [file.bufferId]: result.ok ? result.value : 'failed' } } : r,
      );
    },
    [bridge],
  );

  /** Makes `project` the workbench's project and compares each copy with the file on disk. */
  const enterReview = useCallback(
    async (project: OpenedProject, files: readonly PendingRecoveryFile[]) => {
      if (!(await onProjectOpened(project))) return;
      requested.current.clear();
      setOrphan(null);
      setReview({ project, files, selected: files[0]?.bufferId ?? '', entries: {} });
    },
    [onProjectOpened],
  );

  const startReview = useCallback(
    async (target: PendingRecoveryProject) => {
      if (!bridge) return;
      setBusy(true);
      setError(null);
      setNotice(null);
      try {
        const opened = await bridge.recovery.openProject({ key: target.key });
        if (!opened.ok) {
          // S25.3: the OS privacy protection blocked the folder: say how to allow NoobIDE. Decision 0033: either
          // way the copies stay readable without the project.
          setError(
            opened.code === 'protected-folder' ? protectedFolderKey(rendererPlatform()) : 'recovery.folderMissing',
          );
          requested.current.clear();
          setOrphan({
            project: target,
            files: target.files,
            selected: target.files[0]?.bufferId ?? '',
            entries: {},
            confirm: null,
          });
          return;
        }
        await enterReview(opened.value, target.files);
      } finally {
        setBusy(false);
      }
    },
    [bridge, enterReview],
  );

  // --- Decision 0033: copies of a project whose folder could not be opened ---
  useEffect(() => {
    if (!bridge || !orphan || !orphan.selected || orphan.entries[orphan.selected]) return;
    const { key } = orphan.project;
    const bufferId = orphan.selected;
    if (requested.current.has(bufferId)) return;
    requested.current.add(bufferId);
    void bridge.recovery.readPending({ key, bufferId }).then((result) => {
      setOrphan((o) =>
        o && o.project.key === key
          ? { ...o, entries: { ...o.entries, [bufferId]: result.ok ? result.value : 'failed' } }
          : o,
      );
    });
  }, [bridge, orphan]);

  /** Removes a handled copy; a project without copies leaves the list. */
  const settleOrphan = useCallback(
    (key: string, bufferId: string) => {
      setConfirmDiscard(null);
      if (!orphan || orphan.project.key !== key) return;
      if (orphan.files.some((f) => f.bufferId !== bufferId)) {
        setOrphan((o) => {
          if (!o || o.project.key !== key) return o;
          const files = o.files.filter((f) => f.bufferId !== bufferId);
          return { ...o, files, selected: files[0]?.bufferId ?? '' };
        });
        return;
      }
      setOrphan(null);
      setError(null);
      setPending((p) => (p ? { ...p, projects: p.projects.filter((x) => x.key !== key) } : p));
    },
    [orphan],
  );

  const copyOrphan = useCallback(async (entry: PendingEntry) => {
    setError(null);
    setNotice((await copyText(entry.text)) ? { key: 'recovery.copied' } : { key: 'recovery.copyFailed' });
  }, []);

  const saveOrphanAs = useCallback(
    async (key: string, file: PendingRecoveryFile) => {
      if (!bridge) return;
      setBusy(true);
      setNotice(null);
      try {
        const saved = await bridge.recovery.savePendingAs({ key, bufferId: file.bufferId });
        if (!saved.ok) {
          setError('recovery.saveAsFailed');
          return;
        }
        if (saved.value === null) return; // dialog cancelled
        setError(null);
        setNotice({ key: 'recovery.savedAs', vars: { path: saved.value.path } });
        settleOrphan(key, file.bufferId);
      } finally {
        setBusy(false);
      }
    },
    [bridge, settleOrphan],
  );

  const discardOrphan = useCallback(
    async (key: string, file: PendingRecoveryFile) => {
      if (!bridge) return;
      setNotice(null);
      await bridge.recovery.discardPending({ key, bufferId: file.bufferId });
      settleOrphan(key, file.bufferId);
    },
    [bridge, settleOrphan],
  );

  const relocate = useCallback(
    async (target: OrphanReview, choiceId?: string) => {
      if (!bridge) return;
      setBusy(true);
      setNotice(null);
      try {
        const key = target.project.key;
        const result =
          choiceId === undefined
            ? await bridge.recovery.relocate({ key })
            : await bridge.recovery.relocateConfirm({ key, choiceId });
        if (!result.ok) {
          setOrphan((o) => (o ? { ...o, confirm: null } : o));
          setError(
            result.code === 'protected-folder'
              ? protectedFolderKey(rendererPlatform())
              : result.code === 'expired'
                ? 'recovery.relocateExpired'
                : 'recovery.relocateFailed',
          );
          return;
        }
        const value = result.value;
        if (value.status === 'cancelled') return;
        if (value.status === 'confirm') {
          const { choiceId: id, folderName, missing } = value;
          setOrphan((o) => (o ? { ...o, confirm: { choiceId: id, folderName, missing } } : o));
          return;
        }
        setError(null);
        await enterReview(value.project, target.files);
      } finally {
        setBusy(false);
      }
    },
    [bridge, enterReview],
  );
  // --- end decision 0033 ---

  const select = useCallback((file: PendingRecoveryFile) => {
    setConfirmDiscard(null);
    setError(null);
    setReview((r) => (r ? { ...r, selected: file.bufferId } : r));
  }, []);

  /** Removes a handled file; the dialog closes when nothing is left. */
  const settle = useCallback(
    (bufferId: string) => {
      if (!review) return;
      const files = review.files.filter((f) => f.bufferId !== bufferId);
      setConfirmDiscard(null);
      setError(null);
      if (files.length === 0) {
        setReview(null);
        setOpen(false);
      } else setReview({ ...review, files, selected: files[0]?.bufferId ?? '' });
    },
    [review],
  );

  useEffect(() => {
    // Loads the recovered copy of the selected file (once per file).
    if (review && review.selected && !review.entries[review.selected]) {
      const file = review.files.find((f) => f.bufferId === review.selected);
      if (file) void loadEntry(review.project, file);
    }
  }, [review, loadEntry]);

  const restore = useCallback(
    async (file: PendingRecoveryFile) => {
      if (!bridge || !review) return;
      setBusy(true);
      setError(null);
      try {
        // Read again: the file on disk may have changed since the diff was shown (e.g. another copy was saved).
        const fresh = await bridge.recovery.read({
          projectId: review.project.projectId,
          relPath: file.relPath,
          bufferId: file.bufferId,
        });
        if (!fresh.ok) {
          setReview({ ...review, entries: { ...review.entries, [file.bufferId]: 'failed' } });
          return;
        }
        const outcome = await onRestore(review.project, fresh.value);
        if (outcome === 'restored') settle(file.bufferId);
        else {
          setReview({ ...review, entries: { ...review.entries, [file.bufferId]: fresh.value } });
          setError(outcome === 'save-first' ? 'recovery.saveFirst' : 'recovery.restoreFailed');
        }
      } finally {
        setBusy(false);
      }
    },
    [bridge, review, onRestore, settle],
  );

  const discard = useCallback(
    async (file: PendingRecoveryFile) => {
      if (!bridge || !review) return;
      await bridge.recovery.discard({
        projectId: review.project.projectId,
        relPath: file.relPath,
        bufferId: file.bufferId,
      });
      settle(file.bufferId);
    },
    [bridge, review, settle],
  );

  const clearAll = useCallback(async () => {
    if (!bridge) return;
    const result = await bridge.recovery.clear();
    if (result.ok) {
      setPending(null);
      setReview(null);
      close();
      onCleared();
    }
  }, [bridge, close, onCleared]);

  const selectedFile = review?.files.find((f) => f.bufferId === review.selected) ?? null;
  const selectedEntry = review && selectedFile ? review.entries[selectedFile.bufferId] : undefined;
  const time = useMemo(() => new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'medium' }), [locale]);

  return (
    <>
      {health !== null && (
        <p className="inline-alert save-alert recovery-health" role="alert" data-testid="journal-health">
          <WarningIcon size={15} />
          {t('recovery.journalFailed')}
        </p>
      )}
      {open && pending && (
        <div className="recovery-backdrop">
          <div
            ref={dialogRef}
            className="recovery-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="recovery-title"
            data-testid="recovery-dialog"
            onKeyDown={(event) => {
              if (event.key === 'Escape') close();
            }}
          >
            <h2 id="recovery-title" className="recovery-title">
              <WarningIcon size={16} />
              {t('recovery.title')}
            </h2>
            <p className="recovery-intro">{t('recovery.intro')}</p>
            {error && (
              <p className="inline-alert" role="alert" data-testid="recovery-error">
                {t(error)}
              </p>
            )}
            {notice && (
              <p className="alert-detail recovery-notice" role="status" data-testid="recovery-notice">
                {fill(t(notice.key), notice.vars ?? {})}
              </p>
            )}

            {orphan && !review ? (
              <OrphanSection
                orphan={orphan}
                busy={busy}
                confirmDiscard={confirmDiscard}
                time={time}
                onSelect={(file) => {
                  setConfirmDiscard(null);
                  setNotice(null);
                  setOrphan((o) => (o ? { ...o, selected: file.bufferId } : o));
                }}
                onCopy={(entry) => void copyOrphan(entry)}
                onSaveAs={(file) => void saveOrphanAs(orphan.project.key, file)}
                onAskDiscard={(file) => setConfirmDiscard(file?.bufferId ?? null)}
                onDiscard={(file) => void discardOrphan(orphan.project.key, file)}
                onRelocate={(choiceId) => void relocate(orphan, choiceId)}
                onCancelRelocate={() => setOrphan((o) => (o ? { ...o, confirm: null } : o))}
                onBack={() => {
                  setOrphan(null);
                  setError(null);
                  setNotice(null);
                  setConfirmDiscard(null);
                }}
              />
            ) : !review ? (
              <ul className="recovery-projects">
                {pending.projects.map((p) => (
                  <li key={p.key} className="recovery-project" data-testid="recovery-project">
                    <strong>{p.name}</strong>
                    <span className="alert-detail">{p.rootPath}</span>
                    <span className="alert-detail">{fill(t('recovery.files'), { n: p.files.length })}</span>
                    <ul className="recovery-file-names">
                      {p.files.map((f) => (
                        <li key={f.bufferId}>{f.relPath}</li>
                      ))}
                    </ul>
                    <button
                      type="button"
                      className="primary-button"
                      disabled={busy}
                      onClick={() => void startReview(p)}
                      data-testid="recovery-review"
                    >
                      {t('recovery.review')}
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <div className="recovery-review">
                <div className="recovery-file-tabs" role="tablist" aria-label={t('recovery.compareTitle')}>
                  {review.files.map((f) => (
                    <button
                      key={f.bufferId}
                      type="button"
                      role="tab"
                      aria-selected={f.bufferId === review.selected}
                      className="file-row"
                      onClick={() => select(f)}
                    >
                      {f.relPath}
                    </button>
                  ))}
                </div>
                {selectedFile && (
                  <section className="recovery-compare" aria-label={t('recovery.compareTitle')}>
                    <p className="alert-detail">
                      {t('recovery.updatedAt')}: {time.format(selectedFile.updatedAt)}
                    </p>
                    {selectedEntry === 'failed' ? (
                      <p className="inline-alert" role="alert">
                        {t('recovery.readFailed')}
                      </p>
                    ) : selectedEntry ? (
                      <EntryDiff entry={selectedEntry} />
                    ) : (
                      <p className="placeholder">{t('editor.loading')}</p>
                    )}
                    <div className="recovery-actions">
                      <button
                        type="button"
                        className="primary-button"
                        data-testid="recovery-restore"
                        disabled={busy || !selectedEntry || selectedEntry === 'failed' || !selectedEntry.disk}
                        onClick={() => void restore(selectedFile)}
                      >
                        {t('recovery.restore')}
                      </button>
                      {confirmDiscard === selectedFile.bufferId ? (
                        <>
                          <button
                            type="button"
                            className="quiet-button danger-button"
                            data-testid="recovery-discard-confirm"
                            disabled={busy}
                            onClick={() => void discard(selectedFile)}
                          >
                            {t('recovery.discardConfirm')}
                          </button>
                          <button type="button" className="quiet-button" onClick={() => setConfirmDiscard(null)}>
                            {t('recovery.cancel')}
                          </button>
                        </>
                      ) : (
                        <button
                          type="button"
                          className="quiet-button"
                          data-testid="recovery-discard"
                          disabled={busy}
                          onClick={() => setConfirmDiscard(selectedFile.bufferId)}
                        >
                          {t('recovery.discard')}
                        </button>
                      )}
                    </div>
                  </section>
                )}
              </div>
            )}

            {pending.projects.length === 0 ? (
              // Decision 0033: every copy of a missing folder was saved or discarded; the notice says where to.
              <footer className="recovery-footer">
                <button type="button" className="primary-button" onClick={close} data-testid="recovery-close">
                  {t('recovery.close')}
                </button>
              </footer>
            ) : (
              <footer className="recovery-footer">
                <span className="alert-detail" data-testid="recovery-usage">
                  {fill(t('recovery.usage'), {
                    used: formatBytes(pending.usage.bytes),
                    limit: formatBytes(pending.usage.maxTotalBytes),
                  })}
                </span>
                {confirmClear ? (
                  <>
                    <button
                      type="button"
                      className="quiet-button danger-button"
                      onClick={() => void clearAll()}
                      data-testid="recovery-clear-confirm"
                    >
                      {t('recovery.clearConfirm')}
                    </button>
                    <button type="button" className="quiet-button" onClick={() => setConfirmClear(false)}>
                      {t('recovery.cancel')}
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    className="quiet-button"
                    onClick={() => setConfirmClear(true)}
                    data-testid="recovery-clear"
                  >
                    {t('recovery.clearAll')}
                  </button>
                )}
                <button type="button" className="quiet-button" onClick={close} data-testid="recovery-later">
                  {t('recovery.later')}
                </button>
              </footer>
            )}
          </div>
        </div>
      )}
    </>
  );
}

interface OrphanSectionProps {
  readonly orphan: OrphanReview;
  readonly busy: boolean;
  readonly confirmDiscard: string | null;
  readonly time: Intl.DateTimeFormat;
  onSelect(file: PendingRecoveryFile): void;
  onCopy(entry: PendingEntry): void;
  onSaveAs(file: PendingRecoveryFile): void;
  /** `null` cancels the question. */
  onAskDiscard(file: PendingRecoveryFile | null): void;
  onDiscard(file: PendingRecoveryFile): void;
  /** Without `choiceId`: open the folder dialog; with it: use the folder chosen before despite missing files. */
  onRelocate(choiceId?: string): void;
  onCancelRelocate(): void;
  onBack(): void;
}

/**
 * Decision 0033: the copies of a project whose folder could not be opened, read-only. Nothing here needs the project:
 * Copy uses the clipboard, Save as… and the folder's new location are asked for by main with native dialogs.
 */
function OrphanSection(props: OrphanSectionProps) {
  const { orphan, busy, confirmDiscard, time } = props;
  const { t } = useI18n();
  const file = orphan.files.find((f) => f.bufferId === orphan.selected) ?? null;
  const entry = file ? orphan.entries[file.bufferId] : undefined;
  const readable = entry !== undefined && entry !== 'failed' ? entry : null;
  return (
    <div className="recovery-review" data-testid="recovery-orphan">
      <p className="alert-detail">
        <strong>{orphan.project.name}</strong> · {fill(t('recovery.oldLocation'), { path: orphan.project.rootPath })}
      </p>
      {orphan.confirm ? (
        <div className="inline-alert" role="alert" data-testid="recovery-relocate-question">
          <p>{fill(t('recovery.relocateMissing'), { folder: orphan.confirm.folderName })}</p>
          <ul className="recovery-file-names">
            {orphan.confirm.missing.map((relPath) => (
              <li key={relPath}>{relPath}</li>
            ))}
          </ul>
          <div className="recovery-actions">
            <button
              type="button"
              className="quiet-button"
              data-testid="recovery-relocate-confirm"
              disabled={busy}
              onClick={() => props.onRelocate(orphan.confirm?.choiceId)}
            >
              {t('recovery.relocateConfirm')}
            </button>
            <button type="button" className="quiet-button" onClick={props.onCancelRelocate}>
              {t('recovery.cancel')}
            </button>
          </div>
        </div>
      ) : (
        <div className="recovery-actions">
          <button
            type="button"
            className="primary-button"
            data-testid="recovery-relocate"
            disabled={busy}
            onClick={() => props.onRelocate()}
          >
            {t('recovery.relocate')}
          </button>
          <button type="button" className="quiet-button" data-testid="recovery-back" onClick={props.onBack}>
            {t('recovery.back')}
          </button>
        </div>
      )}
      <div className="recovery-file-tabs" role="tablist" aria-label={t('recovery.readOnlyText')}>
        {orphan.files.map((f) => (
          <button
            key={f.bufferId}
            type="button"
            role="tab"
            aria-selected={f.bufferId === orphan.selected}
            className="file-row"
            onClick={() => props.onSelect(f)}
          >
            {f.relPath}
          </button>
        ))}
      </div>
      {file && (
        <section className="recovery-compare" aria-label={t('recovery.readOnlyText')}>
          <p className="alert-detail">
            {t('recovery.updatedAt')}: {time.format(file.updatedAt)}
          </p>
          {entry === 'failed' ? (
            <p className="inline-alert" role="alert">
              {t('recovery.readFailed')}
            </p>
          ) : readable ? (
            <pre
              className="diff-lines recovery-text"
              tabIndex={0}
              aria-label={t('recovery.readOnlyText')}
              data-testid="recovery-orphan-text"
            >
              {readable.text}
            </pre>
          ) : (
            <p className="placeholder">{t('editor.loading')}</p>
          )}
          <div className="recovery-actions">
            <button
              type="button"
              className="primary-button"
              data-testid="recovery-save-as"
              disabled={busy || !readable}
              onClick={() => props.onSaveAs(file)}
            >
              {t('recovery.saveAs')}
            </button>
            <button
              type="button"
              className="quiet-button"
              data-testid="recovery-copy"
              disabled={busy || !readable}
              onClick={() => readable && props.onCopy(readable)}
            >
              {t('recovery.copy')}
            </button>
            {confirmDiscard === file.bufferId ? (
              <>
                <button
                  type="button"
                  className="quiet-button danger-button"
                  data-testid="recovery-discard-confirm"
                  disabled={busy}
                  onClick={() => props.onDiscard(file)}
                >
                  {t('recovery.discardConfirm')}
                </button>
                <button type="button" className="quiet-button" onClick={() => props.onAskDiscard(null)}>
                  {t('recovery.cancel')}
                </button>
              </>
            ) : (
              <button
                type="button"
                className="quiet-button"
                data-testid="recovery-discard"
                disabled={busy}
                onClick={() => props.onAskDiscard(file)}
              >
                {t('recovery.discard')}
              </button>
            )}
          </div>
        </section>
      )}
    </div>
  );
}

function EntryDiff({ entry }: { entry: RecoveredEntry }) {
  const { t } = useI18n();
  const diff = useMemo(() => (entry.disk ? diffLines(entry.disk.text, entry.text) : null), [entry]);
  if (!entry.disk || !diff) {
    return (
      <div>
        <p className="inline-alert" role="alert" data-testid="recovery-disk-missing">
          {t('recovery.diskMissing')}
        </p>
        <pre className="diff-lines recovery-text" tabIndex={0} aria-label={t('recovery.recoveredText')}>
          {entry.text}
        </pre>
      </div>
    );
  }
  return (
    <div data-testid="recovery-diff">
      <p className="alert-detail">{t('recovery.legend')}</p>
      <p className="recovery-diff-summary">
        {diff.identical
          ? t('recovery.identical')
          : `${fill(t('recovery.added'), { n: diff.added })} · ${fill(t('recovery.removed'), { n: diff.removed })}`}
      </p>
      {diff.tooLarge ? (
        <p className="alert-detail">{t('recovery.tooLarge')}</p>
      ) : (
        <ol className="diff-lines">
          {diff.lines.map((line, index) =>
            line.kind === 'skipped' ? (
              <li key={index} className="diff-line diff-skipped">
                {fill(t('recovery.skipped'), { n: line.count })}
              </li>
            ) : (
              <li key={index} className={`diff-line diff-${line.kind}`} data-kind={line.kind}>
                <span className="diff-sign" aria-hidden="true">
                  {line.kind === 'added' ? '+' : line.kind === 'removed' ? '−' : ' '}
                </span>
                {line.kind !== 'same' && (
                  <span className="sr-only">
                    {t(line.kind === 'added' ? 'recovery.lineAdded' : 'recovery.lineRemoved')}
                  </span>
                )}
                <code>{line.text}</code>
              </li>
            ),
          )}
        </ol>
      )}
    </div>
  );
}
