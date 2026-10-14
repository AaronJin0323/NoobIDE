import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { PreviewLogEntry, PreviewStatus } from '../../shared/ipc/preview-contract';
import { useI18n } from '../i18n/I18nProvider';
import { DotIcon, MonitorIcon, StopIcon, WarningIcon } from './icons';
import {
  EMPTY_LOG,
  STOPPED,
  actionsFor,
  appendLogBatch,
  previewNotUpdated,
  stageMessageKey,
  stateLabelKey,
  viewVisible,
  type LogView,
} from './preview-model';

interface PreviewPaneProps {
  hidden: boolean;
  /** Something of the workbench is drawn over the stage (e.g. the narrow-layout files overlay). */
  covered?: boolean;
  projectId: string | null;
  /** A file of the project failed to save: the page is older than the editor (S10.5). */
  saveFailed?: boolean;
}

/**
 * The preview pane (S04.3). The page itself is an isolated WebContentsView owned by main and positioned over the
 * stage element below — user HTML is never rendered into this React DOM (AGENTS.md invariant). This component only
 * reports where the stage is, offers Start / Stop / Refresh, and lists the page's console output (bounded, S05.3).
 */
export function PreviewPane({ hidden, covered = false, projectId, saveFailed = false }: PreviewPaneProps) {
  const { t } = useI18n();
  const bridge = window.noobide?.preview;
  const [status, setStatus] = useState<PreviewStatus>(STOPPED);
  const [log, setLog] = useState<LogView>(EMPTY_LOG);
  const stageRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!bridge) return undefined;
    return bridge.onEvent((event) => {
      if (event.kind === 'status') setStatus(event.status);
      else setLog((view) => appendLogBatch(view, event.entries, event.dropped, event.throttled));
    });
  }, [bridge]);

  // A preview belongs to one project: switching or closing the project stops it (and its server).
  useEffect(() => {
    if (bridge && status.projectId !== null && status.projectId !== projectId) void bridge.stop();
  }, [bridge, projectId, status.projectId]);

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

  const start = () => {
    if (!bridge || !projectId) return;
    setLog(EMPTY_LOG);
    void bridge.start({ projectId });
  };

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
      <div className="preview-stage" ref={stageRef} data-testid="preview-stage">
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
      <PreviewConsole log={log} />
    </section>
  );
}

function PreviewConsole({ log }: { log: LogView }) {
  const { t } = useI18n();
  return (
    <div className="preview-console" aria-label={t('preview.console')} data-testid="preview-console">
      {(log.dropped > 0 || log.throttled) && (
        <p className="preview-console-dropped" data-testid="preview-console-dropped">
          {t(log.throttled ? 'preview.console.droppedAtLeast' : 'preview.console.dropped').replace(
            '{count}',
            String(log.dropped),
          )}
        </p>
      )}
      {log.entries.length === 0 ? (
        <p className="preview-console-empty">{t('preview.console.empty')}</p>
      ) : (
        <ol className="preview-console-list">
          {log.entries.map((entry, index) => (
            <LogLine key={index} entry={entry} />
          ))}
        </ol>
      )}
    </div>
  );
}

function LogLine({ entry }: { entry: PreviewLogEntry }) {
  const { t } = useI18n();
  const where = entry.url ? `${fileName(entry.url)}${entry.line ? `:${entry.line}` : ''}` : '';
  return (
    <li className={`preview-console-line level-${entry.level}`} data-source={entry.source}>
      <span className="preview-console-level">{t(`preview.level.${entry.level}`)}</span>
      <span className="preview-console-text">{entry.message}</span>
      {where && <span className="preview-console-where">{where}</span>}
    </li>
  );
}

function fileName(url: string): string {
  try {
    const u = new URL(url);
    return decodeURIComponent(u.pathname.split('/').pop() || u.host);
  } catch {
    return url;
  }
}
