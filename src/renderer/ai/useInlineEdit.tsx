import { useCallback, useEffect, useMemo, useReducer, useRef, useState, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { AiEvent } from '../../shared/ipc/ai-contract';
import type { ProblemRecord } from '../../shared/problem';
import { activeEditor, setAiPromptHooks, type EditZone } from '../editor/editor-handle';
import { I18nValueProvider, useI18n } from '../i18n/I18nProvider';
import { fill } from '../recovery/format';
import { rendererPlatform } from '../workbench/file-op-messages';
import { shortcutLabel } from '../../platform/labels';
import { AiConsentPrompt } from './AiConsentPrompt';
import { aiBridge, openAiSettings } from './ai-bridge';
import { useAiStatus } from './ai-status';
import { availabilityOf, aiSurfacesShown } from './chat-model';
import { providerName } from './chat-text';
import { InlineEditPanel, type InlineEditPanelActions } from './InlineEditPanel';
import { buildGenerateRequest, fitIndent, parsePromptLine, promptLinesOf, promptProblems } from './ai-prompt-model';
import {
  acceptProposal,
  buildEditRequest,
  fixInstruction,
  fixLinesOf,
  initialEditState,
  inlineEditReducer,
  rangeTooLarge,
  type InlineEditPhase,
} from './inline-edit-model';

/** What the workbench provides: file facts, the save pipeline, opening a file. */
export interface InlineEditHost {
  /** Project-relative path of an open tab's model URI. */
  relPathOf(uri: string): string | undefined;
  /**
   * The tab cannot be edited (read-only, another encoding) or the file is being renamed, moved or trashed. Asked when
   * the session opens and again right before an accepted change is applied.
   */
  readOnly(relPath: string): boolean;
  /**
   * The applied text reaches the file's save pipeline (recorded like a typed edit when the editor's own change
   * listener did not) and is saved: atomic write, local history.
   */
  commit(relPath: string, text: string): Promise<{ readonly ok: true } | { readonly ok: false; readonly code: string }>;
  /** Opens (or shows) the file in the editor; resolves with its model URI once the editor shows it, else null. */
  showFile(relPath: string): Promise<string | null>;
}

/** S35.2: an accepted "Fix with AI" change, for the resolved-state tracking (problems/useAiFix.ts). */
export interface AiFixCommit {
  readonly record: ProblemRecord;
  readonly saved: boolean;
  readonly saveError?: string;
  /** Preview loads started when the save was requested (usePreviewLoads). */
  readonly loadsAtRequest: number;
}

export interface InlineEditOptions {
  readonly loadsStarted?: () => number;
  readonly onFixCommitted?: (commit: AiFixCommit) => void;
  /** S42.3: the project's current problems (static + runtime), for the context of an `/ai` prompt. */
  readonly problems?: () => readonly ProblemRecord[];
}

interface Session {
  readonly id: number;
  readonly zone: EditZone;
  readonly root: Root;
  readonly relPath: string;
  readonly projectId: string;
  /** The range text the current request was made for (re-read on every send). */
  original: string;
  readonly problem?: { readonly record: ProblemRecord; readonly title: string };
  /** S42.3: an inline `/ai` prompt: the request on the zone's line and that line's indentation. */
  readonly prompt?: { readonly text: string; readonly indent: string };
}

interface Running {
  readonly token: number;
  readonly sessionId: number;
  id: string | null;
  text: string;
  /** Events that arrived before `request()` answered with the id. */
  readonly early: AiEvent[];
}

const ACTIVE: ReadonlySet<InlineEditPhase> = new Set(['instruction', 'consent', 'running', 'review', 'applying']);

/**
 * S35.1 inline edit (Ctrl/Cmd+I) and the S35.2 "Fix with AI" review, one session at a time:
 * open a zone above the lines (selection / whole file / lines around a problem) → instruction (or the problem's
 * error) → `edit` request with bounded context and the UI locale → the answer as a diff → Accept applies it as one
 * undoable editor edit, only while the range still reads what was sent, and saves it through the file's pipeline;
 * Reject / Esc / Stop change nothing. Consent, no key and AI off are handled as in the chat (decision 0025).
 */
export function useInlineEdit(projectId: string | null, host: InlineEditHost, options: InlineEditOptions = {}) {
  const i18n = useI18n();
  const { t, locale } = i18n;
  const api = aiBridge();
  const { status } = useAiStatus(api, projectId);
  const availability = useMemo(
    () =>
      !api ? ({ kind: 'unavailable' } as const) : status ? availabilityOf(status) : ({ kind: 'loading' } as const),
    [api, status],
  );
  const shown = aiSurfacesShown(availability);

  const [session, setSession] = useState<Session | null>(null);
  const [state, dispatch] = useReducer(inlineEditReducer, initialEditState('instruction'));
  const [announcement, setAnnouncement] = useState<{ readonly text: string; readonly n: number }>({ text: '', n: 0 });

  const sessionRef = useRef<Session | null>(null);
  const stateRef = useRef(state);
  stateRef.current = state;
  const runningRef = useRef<Running | null>(null);
  const hostRef = useRef(host);
  hostRef.current = host;
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const statusRef = useRef(availability);
  statusRef.current = availability;
  const localeRef = useRef(locale);
  localeRef.current = locale;
  const counters = useRef({ session: 0, request: 0 });

  const announce = useCallback((text: string) => setAnnouncement((a) => ({ text, n: a.n + 1 })), []);

  const cancelRunning = useCallback(() => {
    const running = runningRef.current;
    runningRef.current = null;
    if (running?.id) void api?.cancel({ requestId: running.id });
  }, [api]);

  /** Ends the session: the request stops, the zone closes, focus goes back to the code. */
  const finish = useCallback(
    (s: Session, message: string | null, focusEditor = true) => {
      if (sessionRef.current !== s) return;
      cancelRunning();
      sessionRef.current = null;
      setSession(null);
      if (focusEditor) s.zone.focusEditor();
      s.zone.dispose();
      // Unmounting a root while another one renders is not allowed: after this turn.
      setTimeout(() => s.root.unmount(), 0);
      if (message) announce(message);
    },
    [announce, cancelRunning],
  );

  const onEvent = useCallback((event: AiEvent) => {
    const running = runningRef.current;
    const s = sessionRef.current;
    if (!running || !s || running.sessionId !== s.id) return;
    if (running.id === null) {
      running.early.push(event);
      return;
    }
    if (event.requestId !== running.id) return;
    if (event.type === 'text') running.text += event.text;
    else if (event.type === 'done') {
      runningRef.current = null;
      dispatch({
        type: 'answer',
        original: s.original,
        // S42.3: generated code is indented like the `/ai` line it replaces.
        text: s.prompt ? fitIndent(running.text, s.prompt.indent) : running.text,
        eol: s.zone.eol,
        ...(event.usage ? { usage: event.usage } : {}), // S39.2
      });
    } else if (event.type === 'error') {
      runningRef.current = null;
      if (event.code === 'cancelled') dispatch({ type: 'cancelled' });
      else if (event.code === 'no-consent') {
        dispatch({ type: 'reset', state: { ...initialEditState('consent', stateRef.current.instruction) } });
      } else dispatch({ type: 'failed', code: event.code, message: event.message });
    }
  }, []);

  useEffect(() => (api ? api.onEvent(onEvent) : undefined), [api, onEvent]);

  const send = useCallback(
    async (instructionOverride?: string) => {
      const s = sessionRef.current;
      if (!s || !api) return;
      const instruction = instructionOverride ?? stateRef.current.instruction;
      if (!instruction.trim()) return;
      const original = s.zone.currentText();
      const fullText = s.zone.modelText();
      if (original === null || fullText === null) return finish(s, null, false);
      dispatch({ type: 'send' });
      if (rangeTooLarge(original)) {
        dispatch({ type: 'failed', code: 'context-too-large' });
        return;
      }
      s.original = original;
      s.zone.markProposal(false);
      const range = { startLine: s.zone.startLine, endLine: s.zone.endLine };
      const request = s.prompt
        ? buildGenerateRequest({
            projectId: s.projectId,
            relPath: s.relPath,
            languageId: s.zone.languageId,
            prompt: instruction,
            fullText,
            line: range.startLine,
            problems: promptProblems(
              optionsRef.current.problems?.() ?? [],
              s.relPath,
              range.startLine,
              new Set(promptLinesOf(fullText)),
            ),
            locale: localeRef.current,
          })
        : buildEditRequest({
            projectId: s.projectId,
            relPath: s.relPath,
            languageId: s.zone.languageId,
            instruction,
            fullText,
            range,
            original,
            locale: localeRef.current,
          });
      counters.current.request += 1;
      const running: Running = { token: counters.current.request, sessionId: s.id, id: null, text: '', early: [] };
      runningRef.current = running;
      let result: Awaited<ReturnType<typeof api.request>>;
      try {
        result = await api.request(request);
      } catch {
        result = { ok: false, code: 'provider-error', message: '' };
      }
      if (runningRef.current !== running) {
        // Stopped or closed while main was starting it: stop it there too.
        if (result.ok) void api.cancel({ requestId: result.value.requestId });
        return;
      }
      if (!result.ok) {
        runningRef.current = null;
        if (result.code === 'no-consent') {
          dispatch({ type: 'reset', state: initialEditState('consent', instruction) });
        } else dispatch({ type: 'failed', code: result.code, message: result.message });
        return;
      }
      running.id = result.value.requestId;
      dispatch({ type: 'started', requestId: running.id });
      for (const event of running.early.splice(0)) onEvent(event);
    },
    [api, finish, onEvent],
  );

  const stop = useCallback(() => {
    cancelRunning();
    dispatch({ type: 'cancelled' });
  }, [cancelRunning]);

  const accept = useCallback(async () => {
    const s = sessionRef.current;
    const proposal = stateRef.current.proposal;
    if (!s || stateRef.current.phase !== 'review' || proposal === null) return;
    dispatch({ type: 'accept' });
    // Re-checked now: the file must still be changeable (it may be being renamed, moved or trashed since the session
    // opened) and the range must still read exactly what was sent.
    const applied = acceptProposal(hostRef.current.readOnly(s.relPath), s.zone, proposal, s.original);
    s.zone.markProposal(false);
    if (!applied.ok) {
      dispatch({ type: applied.reason });
      return;
    }
    const loadsAtRequest = optionsRef.current.loadsStarted?.() ?? 0;
    const saved = await hostRef.current.commit(s.relPath, applied.text);
    if (s.problem) {
      optionsRef.current.onFixCommitted?.({
        record: s.problem.record,
        saved: saved.ok,
        ...(saved.ok ? {} : { saveError: saved.code }),
        loadsAtRequest,
      });
    }
    if (saved.ok) {
      dispatch({ type: 'applied' });
      finish(s, fill(t('ai.edit.applied'), { shortcut: shortcutLabel(rendererPlatform(), 'Z') }));
    } else dispatch({ type: 'save-failed', code: saved.code });
  }, [finish, t]);

  /**
   * Opens a session on a zone; `problem` makes it "Fix with AI", `prompt` an inline `/ai` prompt (S42.3); both are
   * sent right away when they may be.
   */
  const openSession = useCallback(
    (zone: EditZone, relPath: string, problem?: Session['problem'], prompt?: Session['prompt']) => {
      if (!projectId) {
        zone.dispose();
        return;
      }
      const previous = sessionRef.current;
      if (previous) finish(previous, null, false);
      counters.current.session += 1;
      const s: Session = {
        id: counters.current.session,
        zone,
        root: createRoot(zone.container),
        relPath,
        projectId,
        original: zone.original,
        ...(problem ? { problem } : {}),
        ...(prompt ? { prompt } : {}),
      };
      const now = statusRef.current;
      const instruction = problem ? fixInstruction(problem.record) : (prompt?.text ?? '');
      const phase: InlineEditPhase = hostRef.current.readOnly(relPath)
        ? 'read-only'
        : now.kind === 'no-key' || now.kind === 'no-secure-storage'
          ? 'no-key'
          : now.kind === 'ready' && !now.consent
            ? 'consent'
            : 'instruction';
      sessionRef.current = s;
      setSession(s);
      dispatch({ type: 'reset', state: initialEditState(phase, instruction) });
      zone.onClose(() => finish(s, null, false));
      if ((problem || prompt) && phase === 'instruction') void send(instruction);
    },
    [projectId, finish, send],
  );

  /** Ctrl/Cmd+I, the command and the editor's context menu: the selected lines, or the whole file. */
  const start = useCallback(() => {
    const current = sessionRef.current;
    if (current && ACTIVE.has(stateRef.current.phase)) {
      // One edit at a time: go back to it.
      current.zone.container.querySelector<HTMLElement>('textarea, button')?.focus();
      return;
    }
    const access = activeEditor();
    const uri = access?.shownUri();
    const relPath = uri ? hostRef.current.relPathOf(uri) : undefined;
    if (!access?.openEditZone || !relPath) return;
    const zone = access.openEditZone();
    if (zone) openSession(zone, relPath);
  }, [openSession]);

  /** S35.2 "Fix with AI": the lines around the reported line of the reported file, with the original error. */
  const fixProblem = useCallback(
    async (record: ProblemRecord, title: string) => {
      if (!record.file || record.line === undefined) return;
      const uri = await hostRef.current.showFile(record.file);
      const access = activeEditor();
      if (!uri || !access?.openEditZone || access.shownUri() !== uri) return;
      const zone = access.openEditZone(fixLinesOf(Number.MAX_SAFE_INTEGER, record.line));
      if (zone) openSession(zone, record.file, { record, title });
    },
    [openSession],
  );

  /**
   * S42.3: an inline `/ai` prompt on `line` of the file on screen (Enter, Ctrl/Cmd+Enter or the context menu): the
   * zone opens over that line with the request, and it is sent at once (after consent in a new project).
   */
  const runPrompt = useCallback(
    (uri: string, line: number): boolean => {
      const current = sessionRef.current;
      if (current && ACTIVE.has(stateRef.current.phase)) {
        // One AI edit at a time: the key goes back to the open one.
        current.zone.container.querySelector<HTMLElement>('textarea, button')?.focus();
        return true;
      }
      const access = activeEditor();
      const relPath = hostRef.current.relPathOf(uri);
      if (!projectId || !access?.openEditZone || access.shownUri() !== uri || !relPath) return false;
      const zone = access.openEditZone({ startLine: line, endLine: line });
      if (!zone) return false;
      const parsed = parsePromptLine(zone.original);
      if (!parsed?.prompt) {
        zone.dispose();
        return false;
      }
      openSession(zone, relPath, undefined, { text: parsed.prompt, indent: parsed.indent });
      return true;
    },
    [openSession, projectId],
  );

  // S42.3: the editor's `/ai` support follows AI being shown and the locale.
  useEffect(() => {
    const shortcut = shortcutLabel(rendererPlatform(), 'Enter');
    setAiPromptHooks({
      enabled: shown && projectId !== null,
      texts: {
        hintRun: fill(t('aiPrompt.hint.run'), { shortcut }),
        hintShortcut: fill(t('aiPrompt.hint.shortcut'), { shortcut }),
        hintBare: t('aiPrompt.hint.bare'),
        marker: fill(t('aiPrompt.marker'), { shortcut }),
        menu: t('aiPrompt.menu'),
      },
      run: runPrompt,
    });
    return () => setAiPromptHooks(null);
  }, [shown, projectId, t, runPrompt]);

  // AI switched off, or another project: the session ends without changing anything.
  useEffect(() => {
    const s = sessionRef.current;
    if (s && (!shown || s.projectId !== projectId)) finish(s, null, false);
  }, [shown, projectId, finish]);

  const actions = useMemo<InlineEditPanelActions>(
    () => ({
      instruction: (text) => dispatch({ type: 'instruction', text }),
      send: () => void send(),
      stop,
      accept: () => void accept(),
      reject: () => {
        const s = sessionRef.current;
        if (s) finish(s, t('ai.edit.rejected'));
      },
      close: () => {
        const s = sessionRef.current;
        if (!s) return;
        const phase = stateRef.current.phase;
        // Closing while the AI works stops it; nothing was changed in any of these phases except a failed save.
        finish(s, phase === 'save-failed' ? null : t('ai.edit.closed'));
      },
      openSettings: () => openAiSettings(),
    }),
    [send, stop, accept, finish, t],
  );

  const consented = useCallback(() => {
    dispatch({ type: 'consented' });
    const s = sessionRef.current;
    if (s?.problem) void send(stateRef.current.instruction || fixInstruction(s.problem.record));
    else if (s?.prompt) void send(stateRef.current.instruction || s.prompt.text);
  }, [send]);

  // The zone's content lives in its own React root (inside the editor); it is rendered from here.
  const provider = status?.config.provider ?? null;
  useEffect(() => {
    if (!session) return;
    const consent: ReactNode =
      api && state.phase === 'consent' ? (
        <AiConsentPrompt
          api={api}
          projectId={session.projectId}
          providerName={providerName(t, provider)}
          onAllowed={consented}
          onDeclined={() => finish(session, t('ai.edit.consentDeclined'))}
          autoFocus
        />
      ) : null;
    session.root.render(
      <I18nValueProvider value={i18n}>
        <InlineEditPanel
          state={state}
          target={{
            relPath: session.relPath,
            startLine: session.zone.startLine,
            endLine: session.zone.endLine,
            wholeFile: session.zone.wholeFile,
          }}
          original={session.original}
          fixTitle={session.problem?.title}
          promptRequest={session.prompt?.text}
          consent={consent}
          platform={rendererPlatform()}
          actions={actions}
        />
      </I18nValueProvider>,
    );
  }, [session, state, i18n, t, api, provider, actions, consented, finish]);

  // The proposal's lines are highlighted in the editor while it is reviewed.
  useEffect(() => {
    session?.zone.markProposal(state.phase === 'review');
  }, [session, state.phase]);

  // Unmount: nothing keeps running.
  useEffect(
    () => () => {
      const s = sessionRef.current;
      if (s) finish(s, null, false);
    },
    [finish],
  );

  const element = (
    <p className="sr-only" role="status" aria-live="polite" data-testid="inline-edit-announce">
      {announcement.text}
    </p>
  );

  return { shown, start, fixProblem, runPrompt, element, phase: session ? state.phase : null };
}
