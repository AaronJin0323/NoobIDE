import { isImeKey } from '../workbench/ime';
import { useCallback, useEffect, useId, useReducer, useRef, type KeyboardEvent, type PointerEvent } from 'react';
import { createPortal } from 'react-dom';
import type {
  Annotation,
  AnnotationCandidates,
  AnnotationPick,
  AnnotationRegionShot,
  AnnotationSourceState,
  AnnotationsApi,
} from '../../shared/ipc/annotations-contract';
import { ANNOTATION_LIMITS } from '../../shared/ipc/annotations-contract';
import { useI18n } from '../i18n/I18nProvider';
import {
  INITIAL_ANNOTATIONS,
  annotateEntry,
  annotationsOnPage,
  annotationsReducer,
  canSave,
  coversStage,
  fill,
  focusAfter,
  focusStateOf,
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
import { ApproximateIcon, CheckIcon, ListIcon, NoticeIcon, PencilIcon } from '../workbench/icons';
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
  /** Element ids shared with the header entry (aria-controls); generated when absent (unit tests). */
  readonly ids?: AnnotationsIds | undefined;
}

export interface AnnotationsIds {
  readonly list: string;
  readonly ways: string;
}

export interface AnnotateEntryViewProps {
  readonly state: AnnotationsState;
  readonly dispatch: (action: AnnotationsAction) => void;
  readonly t: Translate;
  readonly running: boolean;
  readonly pagePath: string | null;
  readonly ids: AnnotationsIds;
  readonly reasonId: string;
}

/**
 * The Annotate entry in the preview header (always shown, never inside a scroll area): the primary "Annotate page"
 * button with the number of annotations on this page, and "View annotations (N)" for the list. When the preview is
 * not running the button stays visible and focusable, says why it cannot start (tooltip + aria-describedby), and
 * pressing it shows that reason as a notice.
 */
export function AnnotateEntryView({ state, dispatch, t, running, pagePath, ids, reasonId }: AnnotateEntryViewProps) {
  const entry = annotateEntry(running, state.mode);
  const onPage = annotationsOnPage(state.items, pagePath).length;
  const shown = state.scope === 'page' ? onPage : state.items.length;
  const open = entry.available && state.menuOpen;
  const reason = entry.reason ? t(entry.reason) : null;
  return (
    <span className="annotate-entry" data-annotate-entry="">
      <button
        type="button"
        className="annotate-button"
        data-testid="annotate-menu"
        data-available={entry.available ? 'true' : 'false'}
        aria-expanded={open}
        aria-controls={open ? ids.ways : undefined}
        aria-disabled={entry.available ? undefined : 'true'}
        aria-describedby={reason ? reasonId : undefined}
        title={reason ?? t('annotations.annotate.title')}
        onClick={() => {
          if (entry.available) dispatch({ type: 'menu', open: !state.menuOpen });
          else if (!running) dispatch({ type: 'failed', code: 'not-running' });
        }}
      >
        <PencilIcon />
        <span>{t('annotations.annotate')}</span>
        {onPage > 0 && (
          <span className="annotate-badge" data-testid="annotations-count">
            <span aria-hidden="true">{onPage}</span>
            <span className="sr-only">{fill(t('annotations.entry.count'), { count: onPage })}</span>
          </span>
        )}
      </button>
      {reason && (
        <span id={reasonId} className="sr-only" data-testid="annotate-reason">
          {reason}
        </span>
      )}
      <button
        type="button"
        className="quiet-button annotations-toggle"
        data-testid="annotations-toggle"
        aria-expanded={state.expanded}
        aria-controls={ids.list}
        title={state.expanded ? t('annotations.toggle.hide') : t('annotations.toggle.show')}
        onClick={() => dispatch({ type: 'toggle-expanded' })}
      >
        <ListIcon />
        {fill(t('annotations.list.toggle'), { count: shown })}
      </button>
    </span>
  );
}

/** Moves the focus to a control of the header entry (a closed panel must not leave the focus on <body>). */
function focusEntry(testId: 'annotate-menu' | 'annotations-toggle') {
  if (typeof document === 'undefined') return;
  document.querySelector<HTMLElement>(`[data-annotate-entry] [data-testid="${testId}"]`)?.focus();
}

/** Decorative state icons: the state word next to them carries the meaning (never colour or shape alone). */
function StateIcon({ state }: { state: AnnotationSourceState }) {
  if (state === 'found') return <CheckIcon />;
  if (state === 'approximate') return <ApproximateIcon />;
  return <NoticeIcon />;
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
  ids,
}: AnnotationsStripViewProps) {
  const ownListId = useId();
  const ownWaysId = useId();
  const listId = ids?.list ?? ownListId;
  const waysId = ids?.ways ?? ownWaysId;
  const noteId = useId();
  const statusText = statusKey(state.mode);
  const mode = state.mode;
  const pageItems = annotationsOnPage(state.items, pagePath);
  const shown = state.scope === 'page' ? pageItems : state.items;
  const listboxRef = useRef<HTMLUListElement>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const noteRef = useRef<HTMLTextAreaElement>(null);

  const rootRef = useRef<HTMLDivElement>(null);
  const editRef = useRef<HTMLTextAreaElement>(null);
  const deleteQuestionRef = useRef<HTMLDivElement>(null);

  // Focus follows the step, so a keyboard user lands where the next step is, and comes back to the control that
  // started a step when it ends (never left on <body>).
  const focusState = focusStateOf(state);
  const focusBefore = useRef(focusState);
  const { mode: focusMode, editing: focusEditing, deleting: focusDeleting } = focusState;
  useEffect(() => {
    const now = { mode: focusMode, editing: focusEditing, deleting: focusDeleting };
    const target = focusAfter(focusBefore.current, now);
    focusBefore.current = now;
    if (!target) return;
    const root = rootRef.current;
    if (target.kind === 'mode') {
      if (target.mode === 'choosing') listboxRef.current?.focus();
      else if (target.mode === 'drawing') canvasRef.current?.focus();
      else noteRef.current?.focus();
      return;
    }
    if (target.kind === 'edit-input') {
      editRef.current?.focus();
      return;
    }
    if (target.kind === 'delete-question') {
      deleteQuestionRef.current?.focus();
      return;
    }
    // A step ended: only take the focus back if it was in the strip or on the header entry (or lost with the
    // controls that went away).
    const active = typeof document === 'undefined' ? null : document.activeElement;
    const inEntry = active instanceof Element && active.closest('[data-annotate-entry]') !== null;
    if (!root || (active && active !== document.body && !root.contains(active) && !inEntry)) return;
    const control = (testId: string, id?: string) =>
      [...root.querySelectorAll<HTMLElement>(`[data-testid="${testId}"]`)].find(
        (el) => id === undefined || el.closest<HTMLElement>('[data-testid="annotation-item"]')?.dataset.id === id,
      ) ?? null;
    // The Annotate entry lives in the preview header, outside the strip.
    const entry = (testId: string) =>
      document.querySelector<HTMLElement>(`[data-annotate-entry] [data-testid="${testId}"]`);
    const back =
      (target.kind === 'item-control'
        ? control(target.control === 'edit' ? 'annotation-edit' : 'annotation-delete', target.id)
        : null) ??
      entry('annotate-menu') ??
      entry('annotations-toggle');
    back?.focus();
  }, [focusMode, focusEditing, focusDeleting]);

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

  return (
    <div className="annotations" data-testid="annotations-strip" data-mode={mode.kind} ref={rootRef}>
      {running && state.menuOpen && mode.kind === 'idle' && (
        <div
          className="annotations-ways"
          id={waysId}
          role="group"
          aria-label={t('annotations.annotate.ways')}
          data-testid="annotate-ways"
        >
          <span className="annotations-ways-title">{t('annotations.ways.title')}</span>
          <button type="button" className="annotations-way" data-testid="annotate-pick" onClick={ops.pick}>
            {t('annotations.annotate.pick')}
          </button>
          <button type="button" className="annotations-way" data-testid="annotate-list" onClick={ops.candidates}>
            {t('annotations.annotate.list')}
          </button>
          <button type="button" className="annotations-way" data-testid="annotate-region" onClick={ops.region}>
            {t('annotations.annotate.region')}
          </button>
          <button
            type="button"
            className="quiet-button annotations-ways-close"
            data-testid="annotate-ways-close"
            onClick={() => {
              dispatch({ type: 'menu', open: false });
              focusEntry('annotate-menu');
            }}
          >
            {t('annotations.ways.close')}
          </button>
        </div>
      )}

      {/* Always mounted, so a change of mode is announced. */}
      <p className="annotations-status" role="status" aria-live="polite" data-testid="annotate-status">
        {statusText ? t(statusText) : ''}
      </p>

      {(mode.kind === 'picking' || mode.kind === 'loading') && (
        <div className="annotations-step annotations-step-row">
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
          <div className="annotations-actions">
            <button type="button" className="quiet-button" data-testid="annotate-cancel" onClick={ops.cancel}>
              {t('annotations.cancel')}
            </button>
          </div>
        </div>
      )}

      {mode.kind === 'drawing' && (
        <div className="annotations-step annotation-drawing">
          {/* The picture takes the stage's place (the stage is hidden while drawing) and is fitted into it, so
              Confirm and Cancel below always stay on screen. */}
          <div className="annotation-region-frame">
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
              className="annotations-primary"
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
            className="text-field annotation-note-input"
            data-testid="annotation-note-input"
            rows={2}
            maxLength={ANNOTATION_LIMITS.noteChars}
            placeholder={t('annotations.note.placeholder')}
            value={state.draft}
            onChange={(event) => dispatch({ type: 'draft', text: event.target.value })}
            onKeyDown={(event) => {
              if (isImeKey(event.nativeEvent)) return;
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
              className="annotations-primary"
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

      <div id={listId} className="annotations-panel" data-testid="annotations-panel" hidden={!state.expanded}>
        <div className="annotations-panel-head">
          <h3 className="annotations-panel-title">{t('annotations.list.label')}</h3>
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
          <button
            type="button"
            className="quiet-button"
            data-testid="annotations-panel-close"
            onClick={() => {
              dispatch({ type: 'toggle-expanded' });
              focusEntry('annotations-toggle');
            }}
          >
            {t('annotations.ways.close')}
          </button>
        </div>
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
                        ref={editRef}
                        className="text-field annotation-note-input"
                        data-testid="annotation-edit-input"
                        aria-label={t('annotations.note.label')}
                        rows={2}
                        maxLength={ANNOTATION_LIMITS.noteChars}
                        value={editing.text}
                        onChange={(event) => dispatch({ type: 'edit-text', text: event.target.value })}
                        onKeyDown={(event) => {
                          if (isImeKey(event.nativeEvent)) return;
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
                    <div
                      ref={deleteQuestionRef}
                      className="annotations-actions"
                      role="group"
                      tabIndex={-1}
                      aria-label={t('annotations.delete.question')}
                      data-testid="annotation-delete-question"
                    >
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
                        disabled={!running || annotationsOnPage([item], pagePath).length === 0}
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
  /** Where the Annotate entry goes: a slot in the preview header row (null until it is mounted). */
  readonly entrySlot: HTMLElement | null;
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
  entrySlot,
}: AnnotationsStripProps) {
  const { t } = useI18n();
  const listId = useId();
  const waysId = useId();
  const reasonId = useId();
  const ids = { list: listId, ways: waysId };
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

  // Each pick, list, picture or resolve request gets a number; an answer to an older one (cancelled, or replaced by a
  // newer request) is dropped, so it can never jump the strip into naming while another mode runs.
  const seq = useRef(0);
  const fresh = <T,>(handle: (value: T) => void) => {
    const mine = (seq.current += 1);
    return (value: T) => {
      if (seq.current === mine) handle(value);
    };
  };

  const cancel = useCallback(() => {
    seq.current += 1;
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
      if (isImeKey(event)) return;
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
      request(() => api.pick({ projectId }), fresh(picked));
    },
    candidates: () => {
      dispatch({ type: 'loading' });
      request(
        () => api.candidates({ projectId }),
        fresh((value: AnnotationCandidates) =>
          dispatch({ type: 'candidates', items: value.items, truncated: value.truncated }),
        ),
      );
    },
    region: () => {
      dispatch({ type: 'loading' });
      request(
        () => api.regionShot({ projectId }),
        fresh((shot: AnnotationRegionShot) => dispatch({ type: 'shot', shot })),
      );
    },
    cancel,
    choose: (index) => {
      const mode = current.current.mode;
      const item = mode.kind === 'choosing' ? mode.items[index] : undefined;
      if (!item) return;
      dispatch({ type: 'loading' });
      request(() => api.resolve({ projectId, how: { kind: 'path', path: item.path } }), fresh(picked));
    },
    confirmRegion: () => {
      const mode = current.current.mode;
      if (mode.kind !== 'drawing' || !regionUsable(mode.rect)) return;
      const region = regionFractions(mode.rect, mode.shot);
      dispatch({ type: 'loading' });
      request(() => api.resolve({ projectId, how: { kind: 'region', ...region } }), fresh(picked));
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
    <>
      {entrySlot &&
        createPortal(
          <AnnotateEntryView
            state={state}
            dispatch={dispatch}
            t={t}
            running={running}
            pagePath={pagePath}
            ids={ids}
            reasonId={reasonId}
          />,
          entrySlot,
        )}
      <AnnotationsStripView
        state={state}
        dispatch={dispatch}
        ops={ops}
        t={t}
        running={running}
        pagePath={pagePath}
        onAskAi={onAskAi}
        ids={ids}
      />
    </>
  );
}
