import type { IpcMain, IpcMainInvokeEvent } from 'electron';
import {
  ANNOTATION_CHANNELS,
  type Annotation,
  type AnnotationCandidates,
  type AnnotationPick,
  type AnnotationPickError,
  type AnnotationRegionShot,
  type AnnotationResolveHow,
  type AnnotationSource,
  type AnnotationTarget,
} from '../shared/ipc/annotations-contract';
import {
  parseContextRequest,
  parseHighlight,
  parseProjectOnly,
  parseRemove,
  parseResolve,
  parseSave,
  parseUpdate,
} from '../shared/ipc/annotations-parse';
import type { IpcResult } from '../shared/ipc/contract';
import type { Result } from '../shared/result';
import { annotationContext } from '../ai/annotation-context';
import { locateTarget, projectTextReader } from '../preview/annotation-source';
import type { AnnotationStore, StoredAnnotation } from './annotation-store';
import { isTrustedSender, senderInfo } from './ipc';

/**
 * IPC handlers of preview annotations (S41.4, decision 0030). The same checks as the other handlers, in the same
 * order: the sender is the workbench's top-level frame on the app origin, at most one argument, and it passes the
 * channel's parser (annotations-parse.ts) — before the preview or the store is touched. Picking, finding, showing and
 * the region picture need the window that owns the project's preview (S14.6). A picked target stays in main under a
 * random `pickId` (per window, a few at most, 30 minutes) until it is saved with a note; the workbench never sends a
 * target. Source locations are computed again from the files on disk for every list.
 */
export interface AnnotationPreview {
  isOwner(requester: { readonly windowId: number; readonly projectId?: string | undefined }): boolean;
  annotationPick(projectId: string): Promise<Result<AnnotationTarget, AnnotationPickError>>;
  annotationCancelPick(projectId: string): void;
  annotationCandidates(projectId: string): Promise<Result<AnnotationCandidates, AnnotationPickError>>;
  annotationResolve(
    projectId: string,
    how: AnnotationResolveHow,
  ): Promise<Result<AnnotationTarget, AnnotationPickError>>;
  annotationHighlight(projectId: string, path: readonly number[] | null): Promise<Result<null, AnnotationPickError>>;
  annotationRegionShot(projectId: string): Promise<Result<AnnotationRegionShot, AnnotationPickError>>;
}

export interface AnnotationsIpcDeps {
  readonly allowedOrigin: string;
  readonly store: Pick<AnnotationStore, 'list' | 'get' | 'add' | 'update' | 'remove'>;
  readonly preview: AnnotationPreview;
  /** Real root of an open project, or undefined. */
  rootOf(projectId: string): string | undefined;
  newId(): string;
  now?(): number;
}

const FORBIDDEN = { ok: false, code: 'forbidden-sender', message: 'sender is not the workbench' } as const;
const INVALID = { ok: false, code: 'invalid-request', message: 'payload does not match the contract' } as const;
const UNKNOWN_PROJECT = { ok: false, code: 'unknown-project', message: 'project is not open' } as const;
const NOT_OWNER = { ok: false, code: 'not-owner', message: 'another window owns this preview' } as const;

const PICK_TTL_MS = 30 * 60 * 1000;
const PICKS_PER_WINDOW = 5;

function fail<C extends string>(result: { readonly code: C; readonly message: string }): IpcResult<never, C> {
  return { ok: false, code: result.code, message: result.message };
}

export function registerAnnotationsIpcHandlers(ipc: Pick<IpcMain, 'handle'>, deps: AnnotationsIpcDeps): void {
  const { store, preview } = deps;
  const now = deps.now ?? Date.now;
  const picks = new Map<
    string,
    { readonly windowId: number; readonly projectId: string; readonly target: AnnotationTarget; readonly at: number }
  >();

  function handle<P>(
    channel: string,
    parse: (payload: unknown) => P | null,
    run: (payload: P, event: IpcMainInvokeEvent) => Promise<IpcResult<unknown, string>>,
  ): void {
    ipc.handle(channel, async (event, ...args: unknown[]) => {
      if (!isTrustedSender(senderInfo(event), deps.allowedOrigin)) return FORBIDDEN;
      if (args.length > 1) return INVALID;
      const payload = parse(args[0]);
      if (payload === null) return INVALID;
      return run(payload, event);
    });
  }

  const owns = (event: IpcMainInvokeEvent, projectId: string) =>
    preview.isOwner({ windowId: event.sender.id, projectId });

  const sourceOf = (root: string, target: AnnotationTarget): Promise<AnnotationSource> =>
    locateTarget(target, projectTextReader(root));

  const toAnnotation = async (root: string, stored: StoredAnnotation): Promise<Annotation> => ({
    ...stored,
    source: await sourceOf(root, stored.target),
  });

  /** Keeps a picked target for this window and returns it with its source location. */
  const remember = async (
    event: IpcMainInvokeEvent,
    projectId: string,
    root: string,
    result: Result<AnnotationTarget, AnnotationPickError>,
  ): Promise<IpcResult<AnnotationPick, AnnotationPickError>> => {
    if (!result.ok) return fail(result);
    const at = now();
    for (const [id, entry] of picks) if (at - entry.at > PICK_TTL_MS) picks.delete(id);
    const own = [...picks].filter(([, entry]) => entry.windowId === event.sender.id);
    for (const [id] of own.slice(0, Math.max(0, own.length - (PICKS_PER_WINDOW - 1)))) picks.delete(id);
    const pickId = deps.newId();
    picks.set(pickId, { windowId: event.sender.id, projectId, target: result.value, at });
    return { ok: true, value: { pickId, target: result.value, source: await sourceOf(root, result.value) } };
  };

  handle(ANNOTATION_CHANNELS.list, parseProjectOnly, async ({ projectId }) => {
    const root = deps.rootOf(projectId);
    if (root === undefined) return UNKNOWN_PROJECT;
    const stored = await store.list(root);
    const reader = projectTextReader(root); // one read per file for the whole list
    const value = await Promise.all(
      stored.map(async (a) => ({ ...a, source: await locateTarget(a.target, reader) }) satisfies Annotation),
    );
    return { ok: true, value };
  });

  handle(ANNOTATION_CHANNELS.pick, parseProjectOnly, async ({ projectId }, event) => {
    const root = deps.rootOf(projectId);
    if (root === undefined) return UNKNOWN_PROJECT;
    if (!owns(event, projectId)) return NOT_OWNER;
    return remember(event, projectId, root, await preview.annotationPick(projectId));
  });

  handle(ANNOTATION_CHANNELS.cancelPick, parseProjectOnly, async ({ projectId }, event) => {
    if (owns(event, projectId)) preview.annotationCancelPick(projectId);
    return { ok: true, value: null };
  });

  handle(ANNOTATION_CHANNELS.candidates, parseProjectOnly, async ({ projectId }, event) => {
    if (deps.rootOf(projectId) === undefined) return UNKNOWN_PROJECT;
    if (!owns(event, projectId)) return NOT_OWNER;
    const result = await preview.annotationCandidates(projectId);
    return result.ok ? { ok: true, value: result.value } : fail(result);
  });

  handle(ANNOTATION_CHANNELS.regionShot, parseProjectOnly, async ({ projectId }, event) => {
    if (deps.rootOf(projectId) === undefined) return UNKNOWN_PROJECT;
    if (!owns(event, projectId)) return NOT_OWNER;
    const result = await preview.annotationRegionShot(projectId);
    return result.ok ? { ok: true, value: result.value } : fail(result);
  });

  handle(ANNOTATION_CHANNELS.resolve, parseResolve, async ({ projectId, how }, event) => {
    const root = deps.rootOf(projectId);
    if (root === undefined) return UNKNOWN_PROJECT;
    if (!owns(event, projectId)) return NOT_OWNER;
    return remember(event, projectId, root, await preview.annotationResolve(projectId, how));
  });

  handle(ANNOTATION_CHANNELS.save, parseSave, async ({ projectId, pickId, note }, event) => {
    const root = deps.rootOf(projectId);
    if (root === undefined) return UNKNOWN_PROJECT;
    const pick = picks.get(pickId);
    if (!pick || pick.windowId !== event.sender.id || pick.projectId !== projectId || now() - pick.at > PICK_TTL_MS) {
      return { ok: false, code: 'expired', message: 'the picked element is no longer known; pick it again' };
    }
    const added = await store.add(root, note.trim(), pick.target);
    if (!added.ok) return fail(added);
    picks.delete(pickId);
    return { ok: true, value: await toAnnotation(root, added.value) };
  });

  handle(ANNOTATION_CHANNELS.update, parseUpdate, async ({ projectId, id, note }) => {
    const root = deps.rootOf(projectId);
    if (root === undefined) return UNKNOWN_PROJECT;
    const updated = await store.update(root, id, note.trim());
    return updated.ok ? { ok: true, value: await toAnnotation(root, updated.value) } : fail(updated);
  });

  handle(ANNOTATION_CHANNELS.remove, parseRemove, async ({ projectId, id }) => {
    const root = deps.rootOf(projectId);
    if (root === undefined) return UNKNOWN_PROJECT;
    const removed = await store.remove(root, id);
    return removed.ok ? { ok: true, value: null } : fail(removed);
  });

  handle(ANNOTATION_CHANNELS.highlight, parseHighlight, async ({ projectId, id }, event) => {
    const root = deps.rootOf(projectId);
    if (root === undefined) return UNKNOWN_PROJECT;
    if (!owns(event, projectId)) return NOT_OWNER;
    if (id === null) {
      await preview.annotationHighlight(projectId, null);
      return { ok: true, value: null };
    }
    const stored = await store.get(root, id);
    if (!stored) return { ok: false, code: 'not-found', message: 'no such annotation' };
    const shown = await preview.annotationHighlight(projectId, stored.target.path);
    return shown.ok ? { ok: true, value: null } : fail(shown);
  });

  handle(ANNOTATION_CHANNELS.context, parseContextRequest, async ({ projectId, ids, locale }) => {
    const root = deps.rootOf(projectId);
    if (root === undefined) return UNKNOWN_PROJECT;
    const all = await store.list(root);
    const reader = projectTextReader(root);
    const readRel = async (relPath: string) => (await reader(relPath))?.text ?? null;
    const value = [];
    for (const id of ids) {
      const index = all.findIndex((a) => a.id === id);
      const stored = all[index];
      if (!stored) return { ok: false, code: 'not-found', message: 'no such annotation' };
      const source = await locateTarget(stored.target, reader);
      value.push(
        await annotationContext(
          { id, number: index + 1, note: stored.note, target: stored.target, source },
          locale,
          readRel,
        ),
      );
    }
    return { ok: true, value };
  });
}
