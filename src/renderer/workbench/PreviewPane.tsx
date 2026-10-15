import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import type {
  PreviewNoteId,
  PreviewProjectOptions,
  PreviewStatus,
  RefreshMode,
} from '../../shared/ipc/preview-contract';
import { useI18n } from '../i18n/I18nProvider';
import type { MessageKey } from '../i18n/index';
import { DotIcon, MonitorIcon, StopIcon, WarningIcon } from './icons';
// S17.3: console view (levels, filter, clear, page-load attribution) on the same bounded log model.
import { ConsoleView } from './ConsoleView';
import {
  EMPTY_LOG,
  STOPPED,
  appendLogBatch,
  clearLog,
  entryChoice,
  entryToStore,
  isTypingKey,
  nextGeneration,
  pillFor,
  stageMessageKey,
  stateLabelKey,
  toolbarFor,
  viewVisible,
  type LogView,
} from './preview-model';
import { setPreviewCommandTarget } from './preview-commands';

interface PreviewPaneProps {
  hidden: boolean;
  /** Something of the workbench is drawn over the stage (e.g. the narrow-layout files overlay). */
  covered?: boolean;
  projectId: string | null;
  /** A file of the project failed to save: the page is older than the editor (S10.5). */
  saveFailed?: boolean;
  /**
   * S20.2: a project just created from a built-in template. Kept for compatibility: since S14.4 every opened project
   * is offered an automatic start, which main allows for trusted folders (templates are trusted when created).
   */
  autoStartProjectId?: string | null;
}

/** A short message under the toolbar (role=status): one-time notes, results of toolbar actions. */
interface Notice {
  readonly id: string;
  readonly text: MessageKey;
  readonly extra?: MessageKey;
  /** Remembered in app data once dismissed (S14.2 one-time notes). */
  readonly note?: PreviewNoteId;
}

/** How often typing in the editor is reported to main (S14.2 typing pause). */
const TYPING_THROTTLE_MS = 150;

/**
 * The preview pane (S04.3, S14, S15.4). The page itself is an isolated WebContentsView owned by main and positioned
 * over the stage element below — user HTML is never rendered into this React DOM (AGENTS.md invariant). This
 * component reports where the stage is, shows the preview state as text, and offers the toolbar: Start / Refresh /
 * Stop, Open in browser, the entry page, automatic refresh, and under Advanced the developer tools and Clear preview
 * data. Every overlay is part of the layout flow, so the native view can never cover it.
 */
export function PreviewPane({ hidden, covered = false, projectId, saveFailed = false }: PreviewPaneProps) {
  const { t } = useI18n();
  const bridge = window.noobide?.preview;
  const projectConfig = window.noobide?.projectConfig;
  const [status, setStatus] = useState<PreviewStatus>(STOPPED);
  const [log, setLog] = useState<LogView>(EMPTY_LOG);
  const [options, setOptions] = useState<PreviewProjectOptions | null>(null);
  const [needsConsent, setNeedsConsent] = useState(false);
  const [notices, setNotices] = useState<readonly Notice[]>([]);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [notesSeen, setNotesSeen] = useState<readonly PreviewNoteId[] | null>(null);
  /** Refreshes seen since mount (a fast reload can pass 'refreshing' within one render batch). */
  const [refreshes, setRefreshes] = useState(0);
  const stageRef = useRef<HTMLDivElement>(null);
  const advancedId = useId();
  const entryId = useId();
  const refreshId = useId();

  const notify = useCallback((notice: Notice) => {
    setNotices((list) => [...list.filter((n) => n.id !== notice.id), notice]);
  }, []);
  const dismiss = (notice: Notice) => {
    setNotices((list) => list.filter((n) => n.id !== notice.id));
    if (notice.note) {
      setNotesSeen((seen) => [...(seen ?? []), notice.note as PreviewNoteId]);
      void bridge?.noteSeen?.({ note: notice.note });
    }
  };

  useEffect(() => {
    if (!bridge) return undefined;
    let state: PreviewStatus['state'] = 'stopped';
    return bridge.onEvent((event) => {
      if (event.kind === 'status') {
        // S17.3: a start or refresh begins a new page load; its console lines are attributed to it.
        const next = event.status.state;
        if ((next === 'starting' || next === 'refreshing') && next !== state) setLog(nextGeneration);
        if (next === 'refreshing' && next !== state) setRefreshes((n) => n + 1);
        state = next;
        setStatus(event.status);
        if (next !== 'stopped') setNeedsConsent(false);
      } else setLog((view) => appendLogBatch(view, event.entries, event.dropped, event.throttled));
    });
  }, [bridge]);

  // S14.2: which one-time notes were already shown (app data).
  useEffect(() => {
    if (!bridge?.notes) return;
    void bridge.notes().then((result) => setNotesSeen(result.ok ? result.value : []));
  }, [bridge]);

  // S14.2: the first refresh explains, once, that reloading clears what the page was doing.
  useEffect(() => {
    if (refreshes === 0 || notesSeen === null || notesSeen.includes('reload-clears-state')) return;
    notify({ id: 'reload-note', text: 'preview.reloadNote', note: 'reload-clears-state' });
  }, [refreshes, notesSeen, notify]);

  // A preview belongs to one project: switching or closing the project stops it (and its server).
  useEffect(() => {
    if (bridge && status.projectId !== null && status.projectId !== projectId) void bridge.stop();
  }, [bridge, projectId, status.projectId]);

  // --- S14.3 entry page and S14.2 refresh mode, read from .noobide/project.json through main ---
  const loadOptions = useCallback(() => {
    if (!bridge?.options || !projectId) {
      setOptions(null);
      return;
    }
    const asked = projectId;
    void bridge.options({ projectId: asked }).then((result) => {
      if (result.ok && asked === projectId) setOptions(result.value);
    });
  }, [bridge, projectId]);
  useEffect(() => {
    setOptions(null);
    setNotices((list) => list.filter((n) => n.note !== undefined));
    setAdvancedOpen(false);
    loadOptions();
  }, [loadOptions]);
  // The entry may have changed elsewhere (file tree "Set as entry page"): read again whenever a page starts.
  useEffect(() => {
    if (status.state === 'starting') loadOptions();
  }, [status.state, loadOptions]);

  // --- S14.4: offer an automatic start once per opened project. Main runs it only for a trusted folder (Start
  // pressed before, or created from a built-in template); otherwise the stage asks for "Start preview". ---
  const autoTried = useRef<string | null>(null);
  useEffect(() => {
    if (!bridge || !projectId || autoTried.current === projectId) return;
    autoTried.current = projectId;
    setNeedsConsent(false);
    void bridge.start({ projectId, trigger: 'auto' }).then((result) => {
      if (!result.ok && result.code === 'not-trusted' && autoTried.current === projectId) setNeedsConsent(true);
    });
  }, [bridge, projectId]);
  useEffect(() => {
    if (!projectId) autoTried.current = null;
  }, [projectId]);

  const showView = !covered && viewVisible(status, !hidden);

  // Keep the native view exactly over the stage: size changes (ResizeObserver), window resizes and layout changes
  // that move the stage without resizing it (checked after every render).
  const lastSent = useRef('');
  const sendBounds = useCallback(() => {
    if (!bridge) return;
    const rect = stageRef.current?.getBoundingClientRect();
    const bounds = {
      x: rect?.left ?? 0,
      y: rect?.top ?? 0,
      width: rect?.width ?? 0,
      height: rect?.height ?? 0,
      visible: showView && rect !== undefined,
    };
    const key = JSON.stringify(bounds);
    if (key === lastSent.current) return;
    lastSent.current = key;
    void bridge.setBounds(bounds);
  }, [bridge, showView]);

  useLayoutEffect(() => {
    sendBounds();
  });

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return undefined;
    const observer = new ResizeObserver(() => sendBounds());
    observer.observe(stage);
    observer.observe(document.body);
    window.addEventListener('resize', sendBounds);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', sendBounds);
    };
  }, [sendBounds]);

  // --- S14.2: typing in the code editor delays an automatic refresh until the user pauses ---
  const live = status.state !== 'stopped';
  useEffect(() => {
    if (!bridge?.typing || !live) return undefined;
    let last = 0;
    const onKey = (event: KeyboardEvent) => {
      if (!(event.target instanceof Element) || !event.target.closest('.monaco-editor')) return;
      if (!isTypingKey(event)) return;
      const now = Date.now();
      if (now - last < TYPING_THROTTLE_MS) return;
      last = now;
      void bridge.typing?.();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [bridge, live]);

  // --- toolbar actions (also the S15.4 commands) ---
  const start = () => {
    if (!bridge || !projectId) return;
    setLog(EMPTY_LOG);
    setNeedsConsent(false);
    void bridge.start({ projectId, trigger: 'user' });
  };
  const actions = toolbarFor(status, projectId !== null);
  const owner = projectId && status.projectId === projectId ? { projectId } : undefined;
  const refresh = () => {
    if (actions.reload) void bridge?.reload(owner);
  };
  const stop = () => {
    if (actions.stop) void bridge?.stop(owner);
  };
  const openExternal = () => {
    if (!projectId || !actions.openExternal || !bridge?.openExternal) return;
    void bridge
      .openExternal({ projectId })
      .then((result) =>
        notify(
          result.ok
            ? { id: 'external', text: 'preview.openExternal.note' }
            : { id: 'external', text: 'preview.openExternal.failed' },
        ),
      );
  };
  const devTools = () => {
    if (projectId && actions.devTools) void bridge?.devTools?.({ projectId });
  };
  const clearData = () => {
    if (!projectId || !bridge?.clearData) return;
    void bridge
      .clearData({ projectId })
      .then((result) =>
        notify(
          result.ok
            ? { id: 'clear', text: 'preview.clearData.done', extra: 'preview.clearData.externalNote' }
            : { id: 'clear', text: 'preview.clearData.failed' },
        ),
      );
  };

  const handlers = useRef({ refresh, stop, openExternal, devTools, clearData });
  handlers.current = { refresh, stop, openExternal, devTools, clearData };
  useEffect(
    () =>
      setPreviewCommandTarget({
        'preview-refresh': () => handlers.current.refresh(),
        'preview-stop': () => handlers.current.stop(),
        'preview-open-external': () => handlers.current.openExternal(),
        'preview-devtools': () => handlers.current.devTools(),
        'preview-clear-data': () => handlers.current.clearData(),
      }),
    [],
  );

  const chooseEntry = (page: string) => {
    if (!projectId || !projectConfig) return;
    void projectConfig.setEntry({ projectId, entry: entryToStore(page) }).then((result) => {
      if (!result.ok) {
        notify({ id: 'entry', text: result.code === 'invalid-existing' ? 'entry.invalidExisting' : 'entry.failed' });
        return;
      }
      loadOptions();
      // A running preview opens the new entry page at once.
      if (status.projectId === projectId && status.state !== 'stopped') void bridge?.start({ projectId });
    });
  };

  const setRefreshMode = (mode: RefreshMode) => {
    if (!projectId || !bridge?.setRefreshMode || !options) return;
    // Shown at once; put back if it could not be stored.
    const previous = options.refresh;
    setOptions((current) => (current ? { ...current, refresh: mode } : current));
    void bridge.setRefreshMode({ projectId, mode }).then((result) => {
      if (result.ok) setOptions((current) => (current ? { ...current, refresh: result.value } : current));
      else {
        setOptions((current) => (current ? { ...current, refresh: previous } : current));
        notify({
          id: 'refresh-mode',
          text: result.code === 'invalid-existing' ? 'preview.refreshMode.locked' : 'preview.refreshMode.failed',
        });
      }
    });
  };

  const pill = pillFor(status, saveFailed);
  const messageKey = stageMessageKey(status, projectId !== null);
  const consent = needsConsent && status.state === 'stopped' && projectId !== null;
  const entryValue = options ? entryChoice(options.pages, options.entry) : '';
  return (
    <section
      className="region panel preview"
      aria-label={t('region.preview')}
      data-testid="region-preview"
      hidden={hidden}
    >
      <div className="panel-header">
        <h2 className="region-title">{t('region.preview')}</h2>
        <span
          className="state-pill"
          data-testid="preview-state"
          data-state={status.state}
          data-not-updated={pill.label === 'preview.notUpdated' ? 'true' : undefined}
          data-outdated={pill.label === 'preview.outdated' ? 'true' : undefined}
          data-generation={status.generation ?? 0}
          title={pill.detail ? t(pill.detail) : undefined}
          role="status"
        >
          {pill.warning ? <WarningIcon /> : status.state === 'stopped' ? <StopIcon /> : <DotIcon />}
          {t(pill.label)}
        </span>
        <div className="preview-actions" role="toolbar" aria-label={t('preview.toolbar')}>
          {actions.start && (
            <button type="button" className="quiet-button" data-testid="preview-start" onClick={start}>
              {t('preview.start')}
            </button>
          )}
          {actions.reload && (
            <button type="button" className="quiet-button" data-testid="preview-reload" onClick={refresh}>
              {t('preview.reload')}
            </button>
          )}
          {actions.stop && (
            <button type="button" className="quiet-button" data-testid="preview-stop" onClick={stop}>
              {t('preview.stop')}
            </button>
          )}
        </div>
      </div>
      {projectId !== null && (
        <div className="preview-toolbar" data-testid="preview-toolbar">
          <button
            type="button"
            className="quiet-button"
            data-testid="preview-open-external"
            disabled={!actions.openExternal}
            title={t('preview.openExternal.title')}
            onClick={openExternal}
          >
            {t('preview.openExternal')}
          </button>
          <label className="preview-field" htmlFor={entryId}>
            {t('preview.entry')}
          </label>
          <select
            id={entryId}
            className="preview-select"
            data-testid="preview-entry"
            value={entryValue}
            disabled={!options || options.pages.length === 0}
            title={options?.truncated ? t('preview.entry.truncated') : undefined}
            onFocus={loadOptions}
            onChange={(event) => chooseEntry(event.target.value)}
          >
            {options && options.pages.length === 0 && <option value="">{t('preview.entry.none')}</option>}
            {options?.pages.map((page) => (
              <option key={page} value={page}>
                {page.toLowerCase() === 'index.html' ? `${page} ${t('preview.entry.default')}` : page}
              </option>
            ))}
          </select>
          <span className="preview-field">
            <input
              id={refreshId}
              type="checkbox"
              data-testid="preview-auto-refresh"
              checked={options?.refresh !== 'manual'}
              disabled={!options || options.configLocked}
              title={options?.configLocked ? t('preview.refreshMode.locked') : t('preview.refreshMode.title')}
              onChange={(event) => setRefreshMode(event.target.checked ? 'auto' : 'manual')}
            />
            <label htmlFor={refreshId}>{t('preview.refreshMode')}</label>
          </span>
          <button
            type="button"
            className="quiet-button"
            data-testid="preview-advanced"
            aria-expanded={advancedOpen}
            aria-controls={advancedId}
            title={t('preview.advanced.title')}
            onClick={() => setAdvancedOpen((open) => !open)}
          >
            {t('preview.advanced')}
          </button>
        </div>
      )}
      {projectId !== null && advancedOpen && (
        <div className="preview-advanced" id={advancedId} data-testid="preview-advanced-panel">
          <div className="preview-advanced-item">
            <button
              type="button"
              className="quiet-button"
              data-testid="preview-devtools"
              disabled={!actions.devTools}
              onClick={devTools}
            >
              {t('preview.devTools')}
            </button>
            <span className="preview-advanced-detail">{t('preview.devTools.detail')}</span>
          </div>
          <div className="preview-advanced-item">
            <button type="button" className="quiet-button" data-testid="preview-clear-data" onClick={clearData}>
              {t('preview.clearData')}
            </button>
            <span className="preview-advanced-detail">
              {t('preview.clearData.detail')} {t('preview.clearData.externalNote')}
            </span>
          </div>
        </div>
      )}
      {notices.length > 0 && (
        <div className="preview-notices" role="status" data-testid="preview-notices">
          {notices.map((notice) => (
            <p key={notice.id} className="preview-notice" data-testid={`preview-notice-${notice.id}`}>
              <span>
                {t(notice.text)}
                {notice.extra ? ` ${t(notice.extra)}` : ''}
              </span>
              <button type="button" className="quiet-button" onClick={() => dismiss(notice)}>
                {t('preview.note.dismiss')}
              </button>
            </p>
          ))}
        </div>
      )}
      <div className="preview-stage" ref={stageRef} data-testid="preview-stage">
        {consent ? (
          <div className="empty-state" data-testid="preview-consent">
            <span className="empty-icon">
              <MonitorIcon />
            </span>
            <p className="empty-title">{t('preview.consent.title')}</p>
            <p className="empty-detail">{t('preview.consent.detail')}</p>
            <button type="button" className="quiet-button" data-testid="preview-consent-start" onClick={start}>
              {t('preview.start')}
            </button>
          </div>
        ) : (
          messageKey && (
            <div className="empty-state" data-testid="preview-message">
              <span className="empty-icon">
                {status.state === 'unresponsive' || status.state === 'failed' ? (
                  <WarningIcon size={22} />
                ) : (
                  <MonitorIcon />
                )}
              </span>
              <p className="empty-title">
                {status.state === 'stopped' ? t('preview.placeholder') : t(stateLabelKey(status.state))}
              </p>
              <p className="empty-detail">{t(messageKey)}</p>
            </div>
          )
        )}
      </div>
      <ConsoleView log={log} onClear={() => setLog(clearLog)} />
    </section>
  );
}
