import { useCallback, useEffect, useId, useReducer, useRef, type KeyboardEvent, type PointerEvent } from 'react';
import type {
  Annotation,
  AnnotationPick,
  AnnotationSourceState,
  AnnotationsApi,
} from '../../shared/ipc/annotations-contract';
import { ANNOTATION_LIMITS } from '../../shared/ipc/annotations-contract';
import { useI18n } from '../i18n/I18nProvider';
import {
  INITIAL_ANNOTATIONS,
  annotationsOnPage,
  annotationsReducer,
  canSave,
  coversStage,
  fill,
  regionFractions,
  regionUsable,
  sourceSummary,
  stateDetailKey,
  stateWordKey,
  statusKey,
  targetSummary,
  toImagePoint,
  type AnnotationsAction,
  type AnnotationsErrorCode,
  type AnnotationsState,
  type Point,
  type Translate,
} from './annotations-model';
import './annotations.css';

/** Operations of the strip that talk to main; the view only calls them and dispatches plain state changes. */
export interface AnnotationsStripOps {
  pick(): void;
  candidates(): void;
  region(): void;
  /** Leaves any pick mode (and tells main when it is picking in the page). */
  cancel(): void;
  choose(index: number): void;
  confirmRegion(): void;
  save(): void;
  show(id: string): void;
  saveEdit(): void;
  remove(id: string): void;
}

export interface AnnotationsStripViewProps {
  readonly state: AnnotationsState;
  readonly dispatch: (action: AnnotationsAction) => void;
  readonly ops: AnnotationsStripOps;
  readonly t: Translate;
  /** The preview of this project is running: picking and Show are offered. */
  readonly running: boolean;
  /** Page shown in the preview ('' = index page), or null when unknown (every annotation counts as this page). */
  readonly pagePath: string | null;
  readonly onAskAi?: ((annotations: readonly Annotation[]) => void) | undefined;
}

/** Decorative state icons: the state word next to them carries the meaning (never colour or shape alone). */
function StateIcon({ state }: { state: AnnotationSourceState }) {
  return (
    <svg
      width={12}
      height={12}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {state === 'found' ? (
        <path d="M3 8.5l3.2 3L13 4.5" />
      ) : state === 'approximate' ? (
        <path d="M3 6.5c1.6-1.4 3.4-1.4 5 0s3.4 1.4 5 0M3 10.5c1.6-1.4 3.4-1.4 5 0s3.4 1.4 5 0" />
      ) : (
        <>
          <circle cx="8" cy="8" r="6" />
          <path d="M8 4.8v3.8M8 11.2v.1" />
        </>
      )}
    </svg>
  );
}

function SourceLine({ source, t }: { source: Annotation['source']; t: Translate }) {
  const where = sourceSummary(source, t);
  const detail = stateDetailKey(source.state);
  return (
    <p className="annotation-source" data-testid="annotation-source" data-state={source.state}>
      <span className="annotation-state">
        <StateIcon state={source.state} />
        {t(stateWordKey(source.state))}
      </span>
      {where && <span>{` · ${where}`}</span>}
      {detail && <span className="annotation-detail">{` ${t(detail)}`}</span>}
    </p>
  );
}

/**
 * The annotations strip (S41.5): in the layout flow under the preview toolbar, so the native view never covers it.
 * Pure view of `AnnotationsState`; `AnnotationsStrip` below wires it to main. Page text is rendered as text only.
 */
export function AnnotationsStripView({
  state,
  dispatch,
  ops,
  t,
  running,
  pagePath,
  onAskAi,
}: AnnotationsStripViewProps) {
  const listId = useId();
  const waysId = useId();
  const noteId = useId();
  const statusText = statusKey(state.mode);
  const mode = state.mode;
  const pageItems = annotationsOnPage(state.items, pagePath);
  const shown = state.scope === 'page' ? pageItems : state.items;
  const listboxRef = useRef<HTMLUListElement>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const noteRef = useRef<HTMLTextAreaElement>(null);

  // Focus follows the mode, so a keyboard user lands where the next step is.
  useEffect(() => {
    if (mode.kind === 'choosing') listboxRef.current?.focus();
    else if (mode.kind === 'drawing') canvasRef.current?.focus();
    else if (mode.kind === 'naming') noteRef.current?.focus();
  }, [mode.kind]);

  const onListKey = (event: KeyboardEvent<HTMLUListElement>) => {
    if (mode.kind !== 'choosing') return;
    const moves: Record<string, 'next' | 'previous' | 'first' | 'last'> = {
      ArrowDown: 'next',
      ArrowUp: 'previous',
      Home: 'first',
      End: 'last',
    };
    const to = moves[event.key];
    if (to) {
      event.preventDefault();
      dispatch({ type: 'move', to });
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      if (mode.items.length > 0) ops.choose(mode.active);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      ops.cancel();
    }
  };

  const imagePoint = (event: PointerEvent<HTMLDivElement>): Point | null => {
    if (mode.kind !== 'drawing') return null;
    const img = event.currentTarget.querySelector('img');
    const box = (img ?? event.currentTarget).getBoundingClientRect();
    return toImagePoint(
      { x: event.clientX, y: event.clientY },
      { x: box.left, y: box.top, width: box.width, height: box.height },
      mode.shot,
    );
  };

  const onCanvasKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (mode.kind !== 'drawing') return;
    if (event.key === 'Enter') {
      event.preventDefault();
      if (regionUsable(mode.rect)) ops.confirmRegion();
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      ops.cancel();
      return;
    }
    if (event.key.startsWith('Arrow')) {
      event.preventDefault();
      dispatch({ type: 'region-key', key: event.key, shift: event.shiftKey });
    }
  };

  const busy = mode.kind !== 'idle';
  return (
    <div className="annotations" data-testid="annotations-strip">
      <div className="annotations-bar">
        <button
          type="button"
          className="quiet-button annotations-toggle"
          data-testid="annotations-toggle"
          aria-expanded={state.expanded}
          aria-controls={listId}
          title={state.expanded ? t('annotations.toggle.hide') : t('annotations.toggle.show')}
          onClick={() => dispatch({ type: 'toggle-expanded' })}
        >
          <span aria-hidden="true">{state.expanded ? '▾' : '▸'}</span>
          {t('annotations.title')}
          <span className="annotations-count" data-testid="annotations-count">
            {fill(t('annotations.count'), { count: shown.length })}
          </span>
        </button>
        {running && (
          <button
            type="button"
            className="quiet-button"
            data-testid="annotate-menu"
            aria-expanded={state.menuOpen}
            aria-controls={waysId}
            title={t('annotations.annotate.title')}
            disabled={busy}
            onClick={() => dispatch({ type: 'menu', open: !state.menuOpen })}
          >
            {t('annotations.annotate')}
          </button>
        )}
        {state.expanded && (
          <div className="annotations-scope" role="group" aria-label={t('annotations.scope.label')}>
            {(['page', 'all'] as const).map((scope) => (
              <button
                key={scope}
                type="button"
                className="viewport-choice"
                aria-pressed={state.scope === scope}
                data-testid={`annotations-scope-${scope}`}
                onClick={() => dispatch({ type: 'scope', scope })}
              >
                {scope === 'page' ? t('annotations.scope.page') : t('annotations.scope.all')}
              </button>
            ))}
          </div>
        )}
      </div>

      {running && state.menuOpen && mode.kind === 'idle' && (
        <div
          className="annotations-ways"
          id={waysId}
          role="group"
          aria-label={t('annotations.annotate.ways')}
          data-testid="annotate-ways"
        >
          <button type="button" className="quiet-button" data-testid="annotate-pick" onClick={ops.pick}>
            {t('annotations.annotate.pick')}
          </button>
          <button type="button" className="quiet-button" data-testid="annotate-list" onClick={ops.candidates}>
            {t('annotations.annotate.list')}
          </button>
          <button type="button" className="quiet-button" data-testid="annotate-region" onClick={ops.region}>
            {t('annotations.annotate.region')}
          </button>
        </div>
      )}

      {/* Always mounted, so a change of mode is announced. */}
      <p className="annotations-status" role="status" aria-live="polite" data-testid="annotate-status">
        {statusText ? t(statusText) : ''}
      </p>

      {(mode.kind === 'picking' || mode.kind === 'loading') && (
        <div className="annotations-step">
          <button type="button" className="quiet-button" data-testid="annotate-cancel" onClick={ops.cancel}>
            {t('annotations.cancel')}
          </button>
        </div>
      )}

      {mode.kind === 'choosing' && (
        <div className="annotations-step">
          {mode.items.length === 0 ? (
            <p className="annotations-hint">{t('annotations.candidates.empty')}</p>
          ) : (
            <ul
              ref={listboxRef}
              className="annotation-candidates"
              role="listbox"
              tabIndex={0}
              aria-label={t('annotations.candidates.label')}
              aria-activedescendant={`${listId}-c${mode.active}`}
              data-testid="annotation-candidates"
              onKeyDown={onListKey}
            >
              {mode.items.map((item, index) => (
                <li
                  key={item.path.join('.')}
                  id={`${listId}-c${index}`}
                  role="option"
                  aria-selected={index === mode.active}
                  className={index === mode.active ? 'annotation-candidate active' : 'annotation-candidate'}
                  data-testid="annotation-candidate"
                  onClick={() => ops.choose(index)}
                >
                  {item.label}
                </li>
              ))}
            </ul>
          )}
          {mode.truncated && <p className="annotations-hint">{t('annotations.candidates.truncated')}</p>}
          <button type="button" className="quiet-button" data-testid="annotate-cancel" onClick={ops.cancel}>
            {t('annotations.cancel')}
          </button>
        </div>
      )}

      {mode.kind === 'drawing' && (
        <div className="annotations-step">
          <div
            ref={canvasRef}
            className="annotation-region-canvas"
            role="application"
            tabIndex={0}
            aria-label={t('annotations.region.canvas')}
            aria-describedby={`${listId}-region`}
            data-testid="annotation-region-canvas"
            onKeyDown={onCanvasKey}
            onPointerDown={(event) => {
              const at = imagePoint(event);
              if (!at) return;
              event.currentTarget.setPointerCapture?.(event.pointerId);
              event.currentTarget.focus();
              dispatch({ type: 'drag-start', at });
            }}
            onPointerMove={(event) => {
              const at = mode.dragFrom ? imagePoint(event) : null;
              if (at) dispatch({ type: 'drag-move', at });
            }}
            onPointerUp={(event) => {
              const at = imagePoint(event);
              if (at) dispatch({ type: 'drag-end', at });
            }}
          >
            <img src={mode.shot.dataUrl} alt={t('annotations.region.image')} draggable={false} />
            {mode.rect && (
              <div
                className="annotation-region-rect"
                aria-hidden="true"
                style={{
                  left: `${(mode.rect.x / mode.shot.width) * 100}%`,
                  top: `${(mode.rect.y / mode.shot.height) * 100}%`,
                  width: `${(mode.rect.width / mode.shot.width) * 100}%`,
                  height: `${(mode.rect.height / mode.shot.height) * 100}%`,
                }}
              />
            )}
          </div>
          <p className="annotations-hint" id={`${listId}-region`} data-testid="annotation-region-size">
            {mode.rect
              ? fill(t('annotations.region.size'), {
                  width: Math.round(mode.rect.width),
                  height: Math.round(mode.rect.height),
                })
              : t('annotations.region.none')}
          </p>
          <div className="annotations-actions">
            <button
              type="button"
              className="quiet-button"
              data-testid="annotation-region-confirm"
              disabled={!regionUsable(mode.rect)}
              onClick={ops.confirmRegion}
            >
              {t('annotations.region.confirm')}
            </button>
            <button type="button" className="quiet-button" data-testid="annotate-cancel" onClick={ops.cancel}>
              {t('annotations.cancel')}
            </button>
          </div>
        </div>
      )}

      {mode.kind === 'naming' && (
        <div className="annotations-step annotation-naming" data-testid="annotation-naming">
          <p className="annotation-target">
            {t('annotations.picked')} <span data-testid="annotation-picked">{targetSummary(mode.pick.target, t)}</span>
          </p>
          <div className="annotation-where">
            <span>{t('annotations.where')}</span>
            <SourceLine source={mode.pick.source} t={t} />
          </div>
          <label htmlFor={noteId}>{t('annotations.note.label')}</label>
          <textarea
            id={noteId}
            ref={noteRef}
            className="annotation-note-input"
            data-testid="annotation-note-input"
            rows={2}
            maxLength={ANNOTATION_LIMITS.noteChars}
            placeholder={t('annotations.note.placeholder')}
            value={state.draft}
            onChange={(event) => dispatch({ type: 'draft', text: event.target.value })}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.preventDefault();
                ops.cancel();
              } else if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && canSave(state)) {
                event.preventDefault();
                ops.save();
              }
            }}
          />
          <div className="annotations-actions">
            <button
              type="button"
              className="quiet-button"
              data-testid="annotation-save"
              disabled={!canSave(state)}
              onClick={ops.save}
            >
              {t('annotations.save')}
            </button>
            <button type="button" className="quiet-button" data-testid="annotate-cancel" onClick={ops.cancel}>
              {t('annotations.cancel')}
            </button>
          </div>
        </div>
      )}

      {state.notice && (
        <p className="preview-notice annotations-notice" role="status" data-testid="annotations-notice">
          <span>{t(state.notice)}</span>
          <button
            type="button"
            className="quiet-button"
            data-testid="annotations-notice-dismiss"
            onClick={() => dispatch({ type: 'dismiss' })}
          >
            {t('annotations.notice.dismiss')}
          </button>
        </p>
      )}

      <div id={listId} hidden={!state.expanded}>
        {state.loaded && shown.length === 0 && (
          <p className="annotations-hint" data-testid="annotations-empty">
            {state.scope === 'page' ? t('annotations.empty.page') : t('annotations.empty.all')}
          </p>
        )}
        {shown.length > 0 && (
          <ol className="annotations-list" aria-label={t('annotations.list.label')} data-testid="annotations-list">
            {shown.map((item) => {
              const editing = state.editing?.id === item.id ? state.editing : null;
              const deleting = state.confirmDelete === item.id;
              return (
                <li key={item.id} className="annotation-item" data-testid="annotation-item" data-id={item.id}>
                  {editing ? (
                    <div className="annotation-edit">
                      <textarea
                        className="annotation-note-input"
                        data-testid="annotation-edit-input"
                        aria-label={t('annotations.note.label')}
                        rows={2}
                        maxLength={ANNOTATION_LIMITS.noteChars}
                        value={editing.text}
                        onChange={(event) => dispatch({ type: 'edit-text', text: event.target.value })}
                        onKeyDown={(event) => {
                          if (event.key === 'Escape') {
                            event.preventDefault();
                            dispatch({ type: 'edit-cancel' });
                          }
                        }}
                      />
                      <div className="annotations-actions">
                        <button
                          type="button"
                          className="quiet-button"
                          data-testid="annotation-edit-save"
                          disabled={editing.saving || editing.text.trim().length === 0}
                          onClick={ops.saveEdit}
                        >
                          {t('annotations.edit.save')}
                        </button>
                        <button
                          type="button"
                          className="quiet-button"
                          data-testid="annotation-edit-cancel"
                          onClick={() => dispatch({ type: 'edit-cancel' })}
                        >
                          {t('annotations.cancel')}
                        </button>
                      </div>
                    </div>
                  ) : (
                    <p className="annotation-note" data-testid="annotation-note">
                      {item.note}
                    </p>
                  )}
                  <p className="annotation-target" data-testid="annotation-target">
                    {targetSummary(item.target, t)}
                  </p>
                  <SourceLine source={item.source} t={t} />
                  {deleting ? (
                    <div className="annotations-actions" role="group" aria-label={t('annotations.delete.question')}>
                      <span className="annotations-hint">{t('annotations.delete.question')}</span>
                      <button
                        type="button"
                        className="quiet-button danger"
                        data-testid="annotation-delete-confirm"
                        onClick={() => ops.remove(item.id)}
                      >
                        {t('annotations.delete.confirm')}
                      </button>
                      <button
                        type="button"
                        className="quiet-button"
                        data-testid="annotation-delete-cancel"
                        onClick={() => dispatch({ type: 'confirm-delete', id: null })}
                      >
                        {t('annotations.cancel')}
                      </button>
                    </div>
                  ) : (
                    <div className="annotations-actions">
                      <button
                        type="button"
                        className="quiet-button"
                        data-testid="annotation-show"
                        disabled={!running}
                        onClick={() => ops.show(item.id)}
                      >
                        {t('annotations.show')}
                      </button>
                      {!editing && (
                        <button
                          type="button"
                          className="quiet-button"
                          data-testid="annotation-edit"
                          onClick={() => dispatch({ type: 'edit-start', id: item.id })}
                        >
                          {t('annotations.edit')}
                        </button>
                      )}
                      <button
                        type="button"
                        className="quiet-button"
                        data-testid="annotation-delete"
                        onClick={() => dispatch({ type: 'confirm-delete', id: item.id })}
                      >
                        {t('annotations.delete')}
                      </button>
                      {onAskAi && (
                        <button
                          type="button"
                          className="quiet-button"
                          data-testid="annotation-ask-ai"
                          onClick={() => onAskAi([item])}
                        >
                          {t('annotations.askAi')}
                        </button>
                      )}
                    </div>
                  )}
                </li>
              );
            })}
          </ol>
        )}
        {onAskAi && pageItems.length > 0 && (
          <button
            type="button"
            className="quiet-button"
            data-testid="annotations-ask-all"
            onClick={() => onAskAi(pageItems)}
          >
            {t('annotations.askAll')}
          </button>
        )}
      </div>
    </div>
  );
}

interface AnnotationsStripProps {
  readonly api: AnnotationsApi;
  readonly projectId: string;
  /** The preview of this project is running (picking and Show need the page). */
  readonly running: boolean;
  readonly pagePath: string | null;
  /** Changes whenever the page loads again (refresh, save, navigation): the source locations are listed again. */
  readonly reloadKey: number;
  /** The frozen picture replaces the native view while a region is drawn: the pane must hide the view. */
  readonly onCoverChange: (covered: boolean) => void;
  readonly onAskAi?: ((annotations: readonly Annotation[]) => void) | undefined;
}

/** The strip wired to `window.noobide.annotations` (S41.5). */
export function AnnotationsStrip({
  api,
  projectId,
  running,
  pagePath,
  reloadKey,
  onCoverChange,
  onAskAi,
}: AnnotationsStripProps) {
  const { t } = useI18n();
  const [state, dispatch] = useReducer(annotationsReducer, INITIAL_ANNOTATIONS);
  const current = useRef(state);
  current.current = state;
  const project = useRef(projectId);
  project.current = projectId;

  useEffect(() => dispatch({ type: 'project', projectId }), [projectId]);

  /** Runs a request and applies its result only if the project is still the same. */
  const request = useCallback(
    <T, C extends AnnotationsErrorCode>(
      run: () => Promise<{ ok: true; value: T } | { ok: false; code: C }>,
      onValue: (value: T) => void,
    ) => {
      const asked = project.current;
      void run().then(
        (result) => {
          if (project.current !== asked) return;
          if (result.ok) onValue(result.value);
          else dispatch({ type: 'failed', code: result.code });
        },
        () => {
          if (project.current === asked) dispatch({ type: 'failed', code: 'invalid-request' });
        },
      );
    },
    [],
  );

  // The list: on project change and whenever the page loads again (line numbers are re-computed from disk).
  useEffect(() => {
    request(
      () => api.list({ projectId }),
      (items) => dispatch({ type: 'listed', items }),
    );
  }, [api, projectId, reloadKey, request]);

  const covers = coversStage(state.mode);
  useEffect(() => {
    onCoverChange(covers);
  }, [covers, onCoverChange]);
  useEffect(() => () => onCoverChange(false), [onCoverChange]);

  const cancel = useCallback(() => {
    if (current.current.mode.kind === 'picking') void api.cancelPick({ projectId: project.current });
    dispatch({ type: 'cancel' });
  }, [api]);

  // The page went away (stopped, another project): leave any pick mode that needs it.
  const needsPage = state.mode.kind !== 'idle' && state.mode.kind !== 'naming';
  useEffect(() => {
    if (!running && needsPage) cancel();
  }, [running, needsPage, cancel]);

  // Esc cancels page picking even while the focus is elsewhere in the workbench.
  const picking = state.mode.kind === 'picking';
  useEffect(() => {
    if (!picking) return undefined;
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') cancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [picking, cancel]);

  // Leaving with a pick in progress stops it in main.
  useEffect(
    () => () => {
      if (current.current.mode.kind === 'picking') void api.cancelPick({ projectId: project.current });
    },
    [api],
  );

  const picked = (pick: AnnotationPick) => dispatch({ type: 'picked', pick });

  const ops: AnnotationsStripOps = {
    pick: () => {
      dispatch({ type: 'picking' });
      request(() => api.pick({ projectId }), picked);
    },
    candidates: () => {
      dispatch({ type: 'loading' });
      request(
        () => api.candidates({ projectId }),
        (value) => dispatch({ type: 'candidates', items: value.items, truncated: value.truncated }),
      );
    },
    region: () => {
      dispatch({ type: 'loading' });
      request(
        () => api.regionShot({ projectId }),
        (shot) => dispatch({ type: 'shot', shot }),
      );
    },
    cancel,
    choose: (index) => {
      const mode = current.current.mode;
      const item = mode.kind === 'choosing' ? mode.items[index] : undefined;
      if (!item) return;
      dispatch({ type: 'loading' });
      request(() => api.resolve({ projectId, how: { kind: 'path', path: item.path } }), picked);
    },
    confirmRegion: () => {
      const mode = current.current.mode;
      if (mode.kind !== 'drawing' || !regionUsable(mode.rect)) return;
      const region = regionFractions(mode.rect, mode.shot);
      dispatch({ type: 'loading' });
      request(() => api.resolve({ projectId, how: { kind: 'region', ...region } }), picked);
    },
    save: () => {
      const now = current.current;
      if (now.mode.kind !== 'naming' || !canSave(now)) return;
      const { pickId } = now.mode.pick;
      dispatch({ type: 'saving' });
      request(
        () => api.save({ projectId, pickId, note: now.draft }),
        (annotation) => dispatch({ type: 'saved', annotation }),
      );
    },
    show: (id) => {
      request(
        () => api.highlight({ projectId, id }),
        () => undefined,
      );
    },
    saveEdit: () => {
      const editing = current.current.editing;
      if (!editing || editing.text.trim().length === 0) return;
      dispatch({ type: 'edit-saving' });
      request(
        () => api.update({ projectId, id: editing.id, note: editing.text }),
        (annotation) => dispatch({ type: 'updated', annotation }),
      );
    },
    remove: (id) => {
      request(
        () => api.remove({ projectId, id }),
        () => dispatch({ type: 'removed', id }),
      );
    },
  };

  return (
    <AnnotationsStripView
      state={state}
      dispatch={dispatch}
      ops={ops}
      t={t}
      running={running}
      pagePath={pagePath}
      onAskAi={onAskAi}
    />
  );
}
