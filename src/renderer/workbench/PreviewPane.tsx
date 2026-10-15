import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { PreviewStatus } from '../../shared/ipc/preview-contract';
import { useI18n } from '../i18n/I18nProvider';
import { DotIcon, MonitorIcon, StopIcon, WarningIcon } from './icons';
// S17.3: console view (levels, filter, clear, page-load attribution) on the same bounded log model.
import { ConsoleView } from './ConsoleView';
import {
  EMPTY_LOG,
  STOPPED,
  actionsFor,
  appendLogBatch,
  clearLog,
  nextGeneration,
  previewNotUpdated,
  stageMessageKey,
  stateLabelKey,
  viewVisible,
  type LogView,
} from './preview-model';
// S15.3 viewport width; S15.5/S15.6 overlays above the native view.
import { MOBILE_WIDTH, OVERLAY_SELECTOR, coveredBy, viewRect, type ViewportWidth } from './preview-viewport';

interface PreviewPaneProps {
  hidden: boolean;
  /** Something of the workbench is drawn over the stage (e.g. the narrow-layout files overlay). */
  covered?: boolean;
  projectId: string | null;
  /** A file of the project failed to save: the page is older than the editor (S10.5). */
  saveFailed?: boolean;
  /**
   * S20.2: a project just created from a built-in template. Built-in templates are trusted (PLAN §8), so its preview
   * starts by itself once, without the user pressing Start.
   */
  autoStartProjectId?: string | null;
}

/**
 * The preview pane (S04.3). The page itself is an isolated WebContentsView owned by main and positioned over the
 * stage element below — user HTML is never rendered into this React DOM (AGENTS.md invariant). This component only
 * reports where the stage is, offers Start / Stop / Refresh, and lists the page's console output (bounded, S05.3).
 */
export function PreviewPane({
  hidden,
  covered = false,
  projectId,
  saveFailed = false,
  autoStartProjectId = null,
}: PreviewPaneProps) {
  const { t } = useI18n();
  const bridge = window.noobide?.preview;
  const [status, setStatus] = useState<PreviewStatus>(STOPPED);
  const [log, setLog] = useState<LogView>(EMPTY_LOG);
  const stageRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!bridge) return undefined;
    let state: PreviewStatus['state'] = 'stopped';
    return bridge.onEvent((event) => {
      if (event.kind === 'status') {
        // S17.3: a start or refresh begins a new page load; its console lines are attributed to it.
        const next = event.status.state;
        if ((next === 'starting' || next === 'refreshing') && next !== state) setLog(nextGeneration);
        state = next;
        setStatus(event.status);
      } else setLog((view) => appendLogBatch(view, event.entries, event.dropped, event.throttled));
    });
  }, [bridge]);

  // A preview belongs to one project: switching or closing the project stops it (and its server).
  useEffect(() => {
    if (bridge && status.projectId !== null && status.projectId !== projectId) void bridge.stop();
  }, [bridge, projectId, status.projectId]);

  // --- S15.5/S15.6: the native view is always drawn above the workbench DOM, so it hides while a dialog, a modal
  // backdrop or a DOM menu overlaps the stage (any of them, not only the ones the workbench knows about). ---
  const [overlaid, setOverlaid] = useState(false);
  useEffect(() => {
    let frame = 0;
    const check = () => {
      frame = 0;
      const stage = stageRef.current?.getBoundingClientRect();
      if (!stage) return;
      const rects = [...document.querySelectorAll(OVERLAY_SELECTOR)]
        .filter((el) => !stageRef.current?.contains(el))
        .map((el) => el.getBoundingClientRect());
      setOverlaid(coveredBy(stage, rects));
    };
    const schedule = () => {
      if (frame === 0) frame = requestAnimationFrame(check);
    };
    check();
    // Dialogs and menus are mounted and unmounted (conditional rendering), so child-list changes are enough. Only
    // changes that add or remove an overlay count: editor typing re-renders lines and must not cost a layout.
    const isOverlay = (node: Node) =>
      node instanceof Element && (node.matches(OVERLAY_SELECTOR) || node.querySelector(OVERLAY_SELECTOR) !== null);
    const observer = new MutationObserver((records) => {
      if (records.some((r) => [...r.addedNodes].some(isOverlay) || [...r.removedNodes].some(isOverlay))) schedule();
    });
    observer.observe(document.body, { childList: true, subtree: true });
    window.addEventListener('resize', schedule);
    // The stage can also move under an open overlay (a divider drag, a collapsed panel).
    const stageObserver = new ResizeObserver(schedule);
    if (stageRef.current) stageObserver.observe(stageRef.current);
    return () => {
      observer.disconnect();
      stageObserver.disconnect();
      window.removeEventListener('resize', schedule);
      if (frame !== 0) cancelAnimationFrame(frame);
    };
  }, []);
  // --- S15.3: desktop or mobile WIDTH only (not device emulation) ---
  const [viewport, setViewport] = useState<ViewportWidth>('desktop');

  const showView = !covered && !overlaid && viewVisible(status, !hidden);

  // Keep the native view exactly over the stage: size changes (ResizeObserver), window resizes and layout changes
  // that move the stage without resizing it (checked after every render).
  const lastSent = useRef('');
  const sendBounds = useCallback(() => {
    if (!bridge) return;
    const stage = stageRef.current?.getBoundingClientRect();
    const rect = stage
      ? viewRect({ x: stage.left, y: stage.top, width: stage.width, height: stage.height }, viewport)
      : undefined;
    const bounds = {
      x: rect?.x ?? 0,
      y: rect?.y ?? 0,
      width: rect?.width ?? 0,
      height: rect?.height ?? 0,
      visible: showView && rect !== undefined,
    };
    const key = JSON.stringify(bounds);
    if (key === lastSent.current) return;
    lastSent.current = key;
    void bridge.setBounds(bounds);
  }, [bridge, showView, viewport]);

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
    // S15.5/S15.6: moving to a monitor with another scale factor changes devicePixelRatio; re-send then too.
    let ratio: MediaQueryList | null = null;
    const watchRatio = () => {
      ratio?.removeEventListener('change', onRatio);
      ratio = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
      ratio.addEventListener('change', onRatio);
    };
    const onRatio = () => {
      lastSent.current = '';
      sendBounds();
      watchRatio();
    };
    watchRatio();
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', sendBounds);
      ratio?.removeEventListener('change', onRatio);
    };
  }, [sendBounds]);

  const start = () => {
    if (!bridge || !projectId) return;
    setLog(EMPTY_LOG);
    void bridge.start({ projectId });
  };

  // --- S20.2: a project created from a built-in template previews immediately (once per project) ---
  const autoStarted = useRef<string | null>(null);
  useEffect(() => {
    if (!bridge || autoStartProjectId === null || autoStartProjectId !== projectId) return;
    if (autoStarted.current === projectId || status.state !== 'stopped') return;
    autoStarted.current = projectId;
    setLog(EMPTY_LOG);
    void bridge.start({ projectId });
  }, [bridge, autoStartProjectId, projectId, status.state]);
  // --- end S20.2 ---

  const actions = actionsFor(status, projectId !== null);
  const notUpdated = previewNotUpdated(status, saveFailed);
  const messageKey = stageMessageKey(status, projectId !== null);
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
          data-not-updated={notUpdated ? 'true' : undefined}
          title={notUpdated ? t('preview.notUpdatedDetail') : undefined}
          role="status"
        >
          {notUpdated || status.state === 'unresponsive' || status.state === 'failed' ? (
            <WarningIcon />
          ) : status.state === 'stopped' ? (
            <StopIcon />
          ) : (
            <DotIcon />
          )}
          {notUpdated ? t('preview.notUpdated') : t(stateLabelKey(status.state))}
        </span>
        <div className="preview-actions">
          {actions.start && (
            <button type="button" className="quiet-button" data-testid="preview-start" onClick={start}>
              {t('preview.start')}
            </button>
          )}
          {actions.reload && (
            <button
              type="button"
              className="quiet-button"
              data-testid="preview-reload"
              onClick={() => void bridge?.reload()}
            >
              {t('preview.reload')}
            </button>
          )}
          {actions.stop && (
            <button
              type="button"
              className="quiet-button"
              data-testid="preview-stop"
              onClick={() => void bridge?.stop()}
            >
              {t('preview.stop')}
            </button>
          )}
        </div>
      </div>
      {/* S15.3: honest labels — "width", and a note that this is not phone emulation. Shown with a project only. */}
      {projectId !== null && (
        <div
          className="viewport-switch"
          role="group"
          aria-label={t('preview.viewport.label')}
          aria-describedby="preview-viewport-note"
          data-testid="viewport-switch"
          title={t('preview.viewport.note')}
        >
          {(['desktop', 'mobile'] as const).map((choice) => (
            <button
              key={choice}
              type="button"
              className="viewport-choice"
              aria-pressed={viewport === choice}
              data-testid={`viewport-${choice}`}
              onClick={() => setViewport(choice)}
            >
              {choice === 'desktop'
                ? t('preview.viewport.desktop')
                : t('preview.viewport.mobile').replace('{width}', String(MOBILE_WIDTH))}
            </button>
          ))}
          <span id="preview-viewport-note" className="viewport-note" hidden={viewport !== 'mobile'}>
            {t('preview.viewport.note')}
          </span>
        </div>
      )}
      {/* S15.5/S15.6: keyboard focus handoff — Enter on the stage gives the page the focus; F6 in the page returns */}
      <div
        className={viewport === 'mobile' ? 'preview-stage mobile' : 'preview-stage'}
        ref={stageRef}
        data-testid="preview-stage"
        data-viewport={viewport}
        tabIndex={showView ? 0 : -1}
        role={showView ? 'group' : undefined}
        aria-label={showView ? t('preview.stage.label') : undefined}
        onKeyDown={(event) => {
          if (!showView || event.key !== 'Enter' || event.target !== event.currentTarget) return;
          event.preventDefault();
          void bridge?.focus();
        }}
      >
        {messageKey && (
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
        )}
      </div>
      <ConsoleView log={log} onClear={() => setLog(clearLog)} />
    </section>
  );
}
