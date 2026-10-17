import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import type { OpenedProject } from '../../shared/ipc/contract';
import type {
  HistoryApi,
  HistoryFile,
  HistoryGroup,
  HistoryOverview,
  HistoryVersion,
  HistoryVersionText,
} from '../../shared/ipc/history-contract';
import { useI18n } from '../i18n/I18nProvider';
import type { MessageKey } from '../i18n/index';
import { fill, formatBytes } from '../recovery/format';
import type { LineDiff } from '../recovery/line-diff';
import { useModalKeys, useReturnFocus } from '../workbench/focus-trap';
import { WarningIcon } from '../workbench/icons';
import {
  compareVersion,
  groupUndoText,
  historyErrorKey,
  reasonKey,
  restoreOutcomeKey,
  sortHistoryFiles,
  storageText,
  type GroupUndoOutcome,
  type RestoreOutcome,
} from './history-model';
import './history.css';

interface HistoryDialogProps {
  api: HistoryApi;
  project: OpenedProject;
  /** File to select first (the active tab), if it has history. */
  initialRelPath: string | null;
  /** The file's current text: the editor's when it is open (unsaved edits included), else the disk's; null if gone. */
  currentText(relPath: string): Promise<string | null>;
  /**
   * Restores a version of an existing file through the editor: saves unsaved edits, keeps the disk content as a
   * version, then makes the version the tab's content (one undo step) and saves it through the save pipeline.
   */
  onRestore(relPath: string, text: string): Promise<RestoreOutcome>;
  /** A deleted file was created again: open it. */
  onRestoredDeleted(relPath: string): void;
  /**
   * S34.2: undoes one AI agent turn (every file back to its version before the turn, each through the restore path;
   * files changed since are skipped and named). Null when another change is running. Absent: no undo offered.
   */
  onUndoGroup?(group: HistoryGroup): Promise<GroupUndoOutcome | null>;
  onClose(): void;
}

type Notice = { readonly kind: 'ok' | 'error'; readonly text: string };
type Confirm = 'project' | 'all' | { readonly orphan: string } | null;

/**
 * Local history (S21.3, S21.4; PLAN §7 "show the diff first; save the current version before restoring"). Lists the
 * open project's files with history (deleted ones too), each file's versions newest first, and a line diff of the
 * chosen version against the current content. The storage section shows usage and the cleanup policy, opens the
 * history folder, cleans up, clears this project's or all history, and lists histories of projects whose folder is
 * gone (ADR 0006). Modal: focus stays inside, Escape closes.
 */
export function HistoryDialog(props: HistoryDialogProps) {
  const { api, project, initialRelPath, currentText, onRestore, onRestoredDeleted, onUndoGroup, onClose } = props;
  const { t, locale } = useI18n();
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  useReturnFocus(); // focus goes back to the History button / menu entry when the dialog closes
  const [files, setFiles] = useState<readonly HistoryFile[] | null>(null);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [versions, setVersions] = useState<readonly HistoryVersion[] | null>(null);
  const [selectedVersion, setSelectedVersion] = useState<string | null>(null);
  /** The compared version, tagged with the file and version it belongs to (late answers are ignored). */
  const [content, setContent] = useState<{
    relPath: string;
    id: string;
    exists: boolean;
    version: HistoryVersionText;
    current: string | null;
  } | null>(null);
  const [overview, setOverview] = useState<HistoryOverview | null>(null);
  const [groups, setGroups] = useState<readonly HistoryGroup[]>([]);
  const [undoing, setUndoing] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [confirm, setConfirm] = useState<Confirm>(null);
  const [busy, setBusy] = useState(false);
  /** Bumped by every file or version choice: an answer for an older choice is dropped. */
  const choice = useRef(0);
  const time = useMemo(() => new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'medium' }), [locale]);

  const loadFiles = useCallback(async () => {
    const result = await api.files({ projectId: project.projectId });
    if (!result.ok) {
      setFiles([]);
      setNotice({ kind: 'error', text: t(historyErrorKey(result.code)) });
      return [];
    }
    const sorted = sortHistoryFiles(result.value);
    setFiles(sorted);
    return sorted;
  }, [api, project.projectId, t]);

  const loadGroups = useCallback(async () => {
    const result = await api.groups({ projectId: project.projectId });
    setGroups(result.ok ? result.value : []);
  }, [api, project.projectId]);

  const loadOverview = useCallback(async () => {
    const result = await api.overview({ projectId: project.projectId });
    if (result.ok) setOverview(result.value);
  }, [api, project.projectId]);

  const loadVersions = useCallback(
    async (relPath: string) => {
      choice.current += 1;
      const mine = choice.current;
      setVersions(null);
      setSelectedVersion(null);
      setContent(null);
      const result = await api.versions({ projectId: project.projectId, relPath });
      if (mine !== choice.current) return;
      if (!result.ok) {
        setVersions([]);
        setNotice({ kind: 'error', text: t(historyErrorKey(result.code)) });
        return;
      }
      setVersions(result.value);
    },
    [api, project.projectId, t],
  );

  useEffect(() => {
    void loadFiles().then((list) => {
      const first = list.find((f) => f.relPath === initialRelPath) ?? list[0];
      if (first) {
        setSelectedFile(first.relPath);
        void loadVersions(first.relPath);
      }
    });
    void loadOverview();
    void loadGroups();
    // Loaded once when the dialog opens; later loads are explicit (after a restore or a clear).
  }, []);

  // Keyboard users land on the selected file once the list is there (or on Close while it loads).
  const listed = files !== null;
  useEffect(() => {
    const target =
      dialogRef.current?.querySelector<HTMLElement>('[data-autofocus]') ??
      dialogRef.current?.querySelector<HTMLElement>('[data-testid="history-close"]');
    target?.focus();
  }, [listed]);

  const file = files?.find((f) => f.relPath === selectedFile) ?? null;

  const chooseFile = (relPath: string) => {
    setNotice(null);
    setSelectedFile(relPath);
    void loadVersions(relPath);
  };

  const chooseVersion = async (id: string) => {
    if (!file) return;
    choice.current += 1;
    const mine = choice.current;
    const { relPath, exists } = file;
    setNotice(null);
    setSelectedVersion(id);
    setContent(null);
    let current: string | null;
    let version;
    try {
      [version, current] = await Promise.all([
        api.read({ projectId: project.projectId, relPath, id }),
        exists ? currentText(relPath) : Promise.resolve(null),
      ]);
    } catch {
      // The current content could not be read: no comparison is shown rather than a wrong one.
      if (mine === choice.current) setNotice({ kind: 'error', text: t('history.error.generic') });
      return;
    }
    if (mine !== choice.current) return;
    if (!version.ok) {
      setNotice({ kind: 'error', text: t(historyErrorKey(version.code)) });
      return;
    }
    setContent({ relPath, id, exists: exists && current !== null, version: version.value, current });
  };

  const refreshAfterChange = async (relPath: string) => {
    const list = await loadFiles();
    if (list.some((f) => f.relPath === relPath)) {
      setSelectedFile(relPath);
      await loadVersions(relPath);
    }
    await loadOverview();
  };

  const restore = async () => {
    // Exactly the version whose comparison is on screen, for the file it belongs to.
    if (!content || content.relPath !== selectedFile || content.id !== selectedVersion) return;
    setBusy(true);
    setNotice(null);
    try {
      if (content.exists) {
        const outcome = await onRestore(content.relPath, content.version.text);
        setNotice({ kind: outcome === 'restored' ? 'ok' : 'error', text: t(restoreOutcomeKey(outcome)) });
        if (outcome === 'restored') await refreshAfterChange(content.relPath);
      } else {
        const result = await api.restoreDeleted({
          projectId: project.projectId,
          relPath: content.relPath,
          id: content.id,
        });
        if (!result.ok) {
          setNotice({ kind: 'error', text: t(historyErrorKey(result.code)) });
          return;
        }
        setNotice({ kind: 'ok', text: t('history.restoredDeleted') });
        onRestoredDeleted(result.value.relPath);
        await refreshAfterChange(result.value.relPath);
      }
    } finally {
      setBusy(false);
    }
  };

  const undoGroup = async (group: HistoryGroup) => {
    if (!onUndoGroup) return;
    setBusy(true);
    setUndoing(group.id);
    setNotice(null);
    try {
      const outcome = await onUndoGroup(group);
      if (outcome === null) {
        setNotice({ kind: 'error', text: t('history.group.undoBusy') });
        return;
      }
      const text = groupUndoText(t, outcome);
      setNotice({ kind: text.ok ? 'ok' : 'error', text: text.text });
      await loadGroups();
      const list = await loadFiles();
      if (selectedFile && list.some((f) => f.relPath === selectedFile)) await loadVersions(selectedFile);
      await loadOverview();
    } catch {
      setNotice({ kind: 'error', text: t('history.error.generic') });
    } finally {
      setUndoing(null);
      setBusy(false);
    }
  };

  const clear = async (scope: 'project' | 'all') => {
    setConfirm(null);
    setBusy(true);
    try {
      const result = await api.clear(scope === 'all' ? { scope } : { scope, projectId: project.projectId });
      setNotice(
        result.ok ? { kind: 'ok', text: t('history.cleared') } : { kind: 'error', text: t('history.clearFailed') },
      );
      setSelectedFile(null);
      setVersions(null);
      setContent(null);
      await loadFiles();
      await loadGroups();
      await loadOverview();
    } finally {
      setBusy(false);
    }
  };

  const clearOrphan = async (key: string) => {
    setConfirm(null);
    setBusy(true);
    try {
      const result = await api.clear({ scope: 'orphan', key });
      setNotice(
        result.ok ? { kind: 'ok', text: t('history.cleared') } : { kind: 'error', text: t('history.clearFailed') },
      );
      await loadOverview();
    } finally {
      setBusy(false);
    }
  };

  const cleanup = async () => {
    const result = await api.cleanup();
    if (result.ok) {
      setNotice({ kind: 'ok', text: fill(t('history.cleanupDone'), { size: formatBytes(result.value.removedBytes) }) });
    }
    await loadOverview();
  };

  // Escape first cancels an open confirmation, then closes; Tab stays inside (also when focus fell to the page).
  useModalKeys(dialogRef, () => {
    if (busy) return; // the result of a running restore or clear must stay visible
    if (confirm) setConfirm(null);
    else onClose();
  });

  const comparison = content ? compareVersion(content.current, content.version.text) : null;
  const storage = overview ? storageText(t, overview.usage) : null;

  return (
    <div className="dialog-backdrop history-backdrop">
      <div
        ref={dialogRef}
        className="dialog history-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        data-testid="history-dialog"
      >
        <div className="history-head">
          <h2 className="dialog-title" id={titleId}>
            {t('history.title')}
          </h2>
          <button type="button" className="quiet-button" data-testid="history-close" disabled={busy} onClick={onClose}>
            {t('history.close')}
          </button>
        </div>
        <p className="dialog-hint history-intro">{t('history.intro')}</p>
        {notice && (
          <p
            className={notice.kind === 'error' ? 'inline-alert history-notice' : 'history-notice history-ok'}
            role={notice.kind === 'error' ? 'alert' : 'status'}
            data-testid="history-notice"
            data-kind={notice.kind}
          >
            {notice.kind === 'error' && <WarningIcon />}
            {notice.text}
          </p>
        )}

        {groups.length > 0 && (
          <section className="history-groups" aria-label={t('history.groups')} data-testid="history-groups">
            <h3 className="history-column-title">{t('history.groups')}</h3>
            <p className="dialog-hint">{t('history.groups.intro')}</p>
            <ul className="history-group-list">
              {groups.map((g) => (
                <li
                  key={g.id}
                  className="history-group"
                  data-testid="history-group"
                  data-group={g.id}
                  data-undone={g.undoneAt !== null || undefined}
                >
                  <span className="history-group-text">
                    <span className="history-item-main">
                      {g.files.length === 1
                        ? t('history.group.titleOne')
                        : fill(t('history.group.title'), { n: g.files.length })}
                    </span>
                    <small className="history-item-detail">
                      {time.format(g.createdAt)}
                      {g.label ? ` · ${fill(t('history.group.request'), { label: g.label })}` : ''}
                    </small>
                    <small className="history-item-detail history-group-files" data-testid="history-group-files">
                      {g.files.join(' · ')}
                    </small>
                  </span>
                  {g.undoneAt !== null ? (
                    <span className="history-tag" data-testid="history-group-undone">
                      {t('history.group.undone')}
                    </span>
                  ) : (
                    onUndoGroup && (
                      <button
                        type="button"
                        className="secondary-button"
                        data-testid="history-group-undo"
                        disabled={busy}
                        onClick={() => void undoGroup(g)}
                      >
                        {undoing === g.id ? t('history.group.undoing') : t('history.group.undo')}
                      </button>
                    )
                  )}
                </li>
              ))}
            </ul>
          </section>
        )}

        <div className="history-columns">
          <section className="history-column" aria-label={t('history.files')}>
            <h3 className="history-column-title">{t('history.files')}</h3>
            {files && files.length === 0 && <p className="dialog-hint">{t('history.noFiles')}</p>}
            <ul className="history-list" data-testid="history-files">
              {files?.map((f, index) => (
                <li key={f.relPath}>
                  <button
                    type="button"
                    className="history-item"
                    aria-current={f.relPath === selectedFile}
                    data-testid="history-file"
                    disabled={busy}
                    data-path={f.relPath}
                    data-autofocus={f.relPath === initialRelPath || (index === 0 && !initialRelPath) || undefined}
                    onClick={() => chooseFile(f.relPath)}
                  >
                    <span className="history-item-main">{f.relPath}</span>
                    {!f.exists && (
                      <span className="history-tag" data-testid="history-deleted">
                        <WarningIcon size={14} />
                        {t('history.deleted')}
                      </span>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          </section>

          <section className="history-column" aria-label={t('history.versions')}>
            <h3 className="history-column-title">{t('history.versions')}</h3>
            {!file && files && files.length > 0 && <p className="dialog-hint">{t('history.pickFile')}</p>}
            {file && versions && versions.length === 0 && <p className="dialog-hint">{t('history.noVersions')}</p>}
            <ul className="history-list" data-testid="history-versions">
              {versions?.map((v) => (
                <li key={v.id}>
                  <button
                    type="button"
                    className="history-item"
                    aria-current={v.id === selectedVersion}
                    data-testid="history-version"
                    disabled={busy}
                    data-reason={v.reason}
                    onClick={() => void chooseVersion(v.id)}
                  >
                    <span className="history-item-main">{time.format(v.createdAt)}</span>
                    <span className="history-item-detail">
                      {t(reasonKey(v.reason))} · {formatBytes(v.size)}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </section>

          <section className="history-column history-compare" aria-label={t('history.compareCurrent')}>
            {!content && file && versions && versions.length > 0 && (
              <p className="dialog-hint">{t('history.pickVersion')}</p>
            )}
            {comparison?.mode === 'deleted' && (
              <>
                <p className="dialog-hint">{t('history.compareDeleted')}</p>
                <pre className="diff-lines history-text" tabIndex={0} aria-label={t('history.versionText')}>
                  {comparison.text}
                </pre>
              </>
            )}
            {comparison?.mode === 'diff' && <VersionDiff diff={comparison.diff} />}
            {content && file && (
              <div className="history-restore">
                <p className="dialog-hint">{t(file.exists ? 'history.restoreNote' : 'history.restoreDeletedNote')}</p>
                <button
                  type="button"
                  className="primary-button"
                  data-testid="history-restore"
                  disabled={busy || (comparison?.mode === 'diff' && comparison.diff.identical)}
                  onClick={() => void restore()}
                >
                  {busy ? t('history.restoring') : t(file.exists ? 'history.restore' : 'history.restoreDeleted')}
                </button>
              </div>
            )}
          </section>
        </div>

        <section className="history-storage" aria-label={t('history.storage')} data-testid="history-storage">
          <h3 className="history-column-title">{t('history.storage')}</h3>
          {storage && overview && (
            <>
              <p className="history-usage" data-testid="history-usage">
                {storage.usage}
              </p>
              <p className="dialog-hint">{storage.policy}</p>
              {overview.usage.unavailable > 0 && (
                <p className="dialog-hint">{fill(t('history.unavailableCount'), { n: overview.usage.unavailable })}</p>
              )}
              {overview.usage.quarantined > 0 && (
                <p className="dialog-hint">{fill(t('history.quarantined'), { n: overview.usage.quarantined })}</p>
              )}
              <p className="dialog-hint">
                {t('history.location')}{' '}
                <span className="history-path" data-testid="history-location">
                  {overview.location}
                </span>
              </p>
            </>
          )}
          <div className="history-actions">
            <button
              type="button"
              className="secondary-button"
              data-testid="history-reveal"
              disabled={busy}
              onClick={() => void api.reveal()}
            >
              {t('history.reveal')}
            </button>
            <button
              type="button"
              className="secondary-button"
              data-testid="history-cleanup"
              disabled={busy}
              onClick={() => void cleanup()}
            >
              {t('history.cleanup')}
            </button>
            <button
              type="button"
              className="secondary-button"
              data-testid="history-clear-project"
              disabled={busy}
              onClick={() => setConfirm('project')}
            >
              {t('history.clearProject')}
            </button>
            <button
              type="button"
              className="secondary-button"
              data-testid="history-clear-all"
              disabled={busy}
              onClick={() => setConfirm('all')}
            >
              {t('history.clearAll')}
            </button>
          </div>
          {(confirm === 'project' || confirm === 'all') && (
            <div className="inline-alert history-confirm" role="alert" data-testid="history-confirm">
              <WarningIcon />
              <div>
                {t(confirm === 'all' ? 'history.clearAllConfirm' : 'history.clearProjectConfirm')}
                <span className="alert-actions">
                  <button type="button" className="secondary-button" onClick={() => setConfirm(null)}>
                    {t('history.cancel')}
                  </button>
                  <button
                    type="button"
                    className="secondary-button danger-button"
                    data-testid="history-confirm-clear"
                    onClick={() => void clear(confirm)}
                    disabled={busy}
                  >
                    {t('history.confirm')}
                  </button>
                </span>
              </div>
            </div>
          )}
          <h4 className="history-subtitle">{t('history.orphans')}</h4>
          <p className="dialog-hint">{t('history.orphansIntro')}</p>
          {overview && overview.orphans.length === 0 && <p className="dialog-hint">{t('history.orphansNone')}</p>}
          <ul className="history-orphans" data-testid="history-orphans">
            {overview?.orphans.map((o) => (
              <li key={o.key} className="history-orphan" data-testid="history-orphan">
                <span className="history-orphan-text">
                  <span className="history-path">{o.rootPath}</span>
                  <small className="dialog-hint">
                    {fill(t('history.orphanSize'), { files: o.files, size: formatBytes(o.bytes) })}
                  </small>
                </span>
                {typeof confirm === 'object' && confirm?.orphan === o.key ? (
                  <span className="alert-actions history-orphan-confirm" role="alert">
                    <span>{t('history.clearOrphanConfirm')}</span>
                    <button type="button" className="secondary-button" onClick={() => setConfirm(null)}>
                      {t('history.cancel')}
                    </button>
                    <button
                      type="button"
                      className="secondary-button danger-button"
                      data-testid="history-orphan-confirm"
                      onClick={() => void clearOrphan(o.key)}
                    >
                      {t('history.confirm')}
                    </button>
                  </span>
                ) : (
                  <button
                    type="button"
                    className="secondary-button"
                    data-testid="history-orphan-clear"
                    disabled={busy}
                    onClick={() => setConfirm({ orphan: o.key })}
                  >
                    {t('history.orphanClear')}
                  </button>
                )}
              </li>
            ))}
          </ul>
        </section>
      </div>
    </div>
  );
}

/** The line diff of a version (also used by the Checkpoints window, S56.2: same "+ comes back" semantics). */
export function VersionDiff({ diff }: { diff: LineDiff }) {
  const { t } = useI18n();
  const summary: MessageKey | null = diff.identical ? 'history.identical' : null;
  return (
    <div data-testid="history-diff">
      <p className="dialog-hint">{t('history.legend')}</p>
      <p className="recovery-diff-summary" data-testid="history-diff-summary">
        {summary
          ? t(summary)
          : `${fill(t('history.added'), { n: diff.added })} · ${fill(t('history.removed'), { n: diff.removed })}`}
      </p>
      {diff.tooLarge ? (
        <p className="dialog-hint">{t('history.tooLarge')}</p>
      ) : (
        <ol className="diff-lines" tabIndex={0} aria-label={t('history.compareCurrent')}>
          {diff.lines.map((line, index) =>
            line.kind === 'skipped' ? (
              <li key={index} className="diff-line diff-skipped">
                {fill(t('history.skipped'), { n: line.count })}
              </li>
            ) : (
              <li key={index} className={`diff-line diff-${line.kind}`} data-kind={line.kind}>
                <span className="diff-sign" aria-hidden="true">
                  {line.kind === 'added' ? '+' : line.kind === 'removed' ? '−' : ' '}
                </span>
                {line.kind !== 'same' && (
                  <span className="sr-only">
                    {t(line.kind === 'added' ? 'history.lineAdded' : 'history.lineRemoved')}
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
