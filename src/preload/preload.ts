import { contextBridge, ipcRenderer } from 'electron';
import { CHANNELS, EVENTS, IPC_API_VERSION, type NoobideApi, type WorkspaceChanged } from '../shared/ipc/contract';
import { PREVIEW_CHANNELS, PREVIEW_EVENT_CHANNEL, type PreviewEvent } from '../shared/ipc/preview-contract';
import { platformId } from '../platform/index';
import { APP_DATA_CHANNELS } from '../shared/ipc/app-data-contract';
import { COMMAND_CHANNELS, COMMAND_EVENTS } from '../shared/ipc/commands-contract'; // S24.2
import { isCommandId } from '../shared/commands';
import { WALKTHROUGH_CHANNELS } from '../shared/ipc/walkthrough-contract';
import { PROBLEMS_CHANNELS, PROBLEMS_EVENT_CHANNEL } from '../shared/ipc/problems-contract'; // S16.2
import type { ProblemRecord } from '../shared/problem';
import { AI_CHANNELS, AI_EVENT_CHANNEL, type AiEvent } from '../shared/ipc/ai-contract'; // S31
import { AI_HISTORY_CHANNELS } from '../shared/ipc/ai-history-contract'; // S39
import { ANNOTATION_CHANNELS } from '../shared/ipc/annotations-contract'; // S41
import { SEARCH_CHANNELS } from '../shared/ipc/search-contract'; // S51.2

/**
 * Restricted bridge for the trusted workbench (sandboxed preload, S03.1). Exposes exactly the calls of the typed
 * contract in src/shared/ipc — never ipcRenderer itself, Node or a generic "send any channel" function. Main
 * validates every payload and sender again; this file only forwards. Event listeners never receive the IPC event.
 */
const api: NoobideApi = {
  apiVersion: IPC_API_VERSION,
  platform: platformId(),
  workspace: {
    openFolder: () => ipcRenderer.invoke(CHANNELS.openFolder),
    readFile: (request) => ipcRenderer.invoke(CHANNELS.readFile, request),
    writeFile: (request) => ipcRenderer.invoke(CHANNELS.writeFile, request),
    revealProject: (request) => ipcRenderer.invoke(CHANNELS.revealProject, request),
    // ── S07/S08: file tree, watcher and file operations ──
    listDir: (request) => ipcRenderer.invoke(CHANNELS.listDir, request),
    onChanged: (listener) => {
      // The event object (with `sender`) never reaches the page; only the cloned payload does.
      const handler = (_event: unknown, change: WorkspaceChanged) => listener(change);
      ipcRenderer.on(EVENTS.changed, handler);
      return () => void ipcRenderer.removeListener(EVENTS.changed, handler);
    },
    createEntry: (request) => ipcRenderer.invoke(CHANNELS.createEntry, request),
    renameEntry: (request) => ipcRenderer.invoke(CHANNELS.renameEntry, request),
    trashEntry: (request) => ipcRenderer.invoke(CHANNELS.trashEntry, request),
    revealEntry: (request) => ipcRenderer.invoke(CHANNELS.revealEntry, request),
    saveCopy: (request) => ipcRenderer.invoke(CHANNELS.saveCopy, request),
  },
  app: {
    onCloseRequested(listener) {
      const forward = () => listener();
      ipcRenderer.on(EVENTS.closeRequested, forward);
      return () => {
        ipcRenderer.removeListener(EVENTS.closeRequested, forward);
      };
    },
    answerClose: (answer) => ipcRenderer.invoke(CHANNELS.answerClose, answer),
    closeDiscarding: () => ipcRenderer.invoke(CHANNELS.closeDiscarding),
  },
  // S04.3 preview: the listener receives only the event payload, never the IpcRendererEvent (it exposes `sender`).
  preview: {
    start: (request) => ipcRenderer.invoke(PREVIEW_CHANNELS.start, request),
    stop: (request) => ipcRenderer.invoke(PREVIEW_CHANNELS.stop, request),
    reload: (request) => ipcRenderer.invoke(PREVIEW_CHANNELS.reload, request),
    goToEntry: (request) => ipcRenderer.invoke(PREVIEW_CHANNELS.goToEntry, request),
    setBounds: (bounds) => ipcRenderer.invoke(PREVIEW_CHANNELS.setBounds, bounds),
    // S14.2–S14.5, S15.4: refresh mode, typing pause, notes, entry picker, storage, toolbar
    typing: () => ipcRenderer.invoke(PREVIEW_CHANNELS.typing),
    setRefreshMode: (request) => ipcRenderer.invoke(PREVIEW_CHANNELS.setRefreshMode, request),
    notes: () => ipcRenderer.invoke(PREVIEW_CHANNELS.notes),
    noteSeen: (request) => ipcRenderer.invoke(PREVIEW_CHANNELS.noteSeen, request),
    options: (request) => ipcRenderer.invoke(PREVIEW_CHANNELS.options, request),
    clearData: (request) => ipcRenderer.invoke(PREVIEW_CHANNELS.clearData, request),
    openExternal: (request) => ipcRenderer.invoke(PREVIEW_CHANNELS.openExternal, request),
    devTools: (request) => ipcRenderer.invoke(PREVIEW_CHANNELS.devTools, request),
    focus: () => ipcRenderer.invoke(PREVIEW_CHANNELS.focus),
    onEvent: (listener) => {
      const wrapped = (_event: unknown, payload: PreviewEvent) => listener(payload);
      ipcRenderer.on(PREVIEW_EVENT_CHANNEL, wrapped);
      return () => void ipcRenderer.removeListener(PREVIEW_EVENT_CHANNEL, wrapped);
    },
  },
  // --- S12 crash-recovery journal ---
  recovery: {
    record: (request) => ipcRenderer.invoke(CHANNELS.recoveryRecord, request),
    discardSaved: (request) => ipcRenderer.invoke(CHANNELS.recoveryDiscardSaved, request),
    listPending: () => ipcRenderer.invoke(CHANNELS.recoveryListPending),
    openProject: (request) => ipcRenderer.invoke(CHANNELS.recoveryOpenProject, request),
    read: (request) => ipcRenderer.invoke(CHANNELS.recoveryRead, request),
    discard: (request) => ipcRenderer.invoke(CHANNELS.recoveryDiscard, request),
    clear: () => ipcRenderer.invoke(CHANNELS.recoveryClear),
    readPending: (request) => ipcRenderer.invoke(CHANNELS.recoveryReadPending, request),
    discardPending: (request) => ipcRenderer.invoke(CHANNELS.recoveryDiscardPending, request),
    savePendingAs: (request) => ipcRenderer.invoke(CHANNELS.recoverySavePendingAs, request),
    relocate: (request) => ipcRenderer.invoke(CHANNELS.recoveryRelocate, request),
    relocateConfirm: (request) => ipcRenderer.invoke(CHANNELS.recoveryRelocateConfirm, request),
  },
  // --- end S12 ---
  // --- S13 app data ---
  settings: {
    get: () => ipcRenderer.invoke(APP_DATA_CHANNELS.settingsGet),
    update: (patch) => ipcRenderer.invoke(APP_DATA_CHANNELS.settingsUpdate, patch),
  },
  logs: {
    openFolder: () => ipcRenderer.invoke(APP_DATA_CHANNELS.openLogsFolder),
  },
  notices: {
    open: () => ipcRenderer.invoke(APP_DATA_CHANNELS.openThirdPartyNotices),
  },
  projectConfig: {
    get: (request) => ipcRenderer.invoke(APP_DATA_CHANNELS.projectConfig, request),
    setEntry: (request) => ipcRenderer.invoke(APP_DATA_CHANNELS.projectSetEntry, request),
  },
  // The welcome screen's shape (plain values); a refused call reads as "nothing" (empty list / not opened).
  recentProjects: {
    list: async () => {
      const result = await ipcRenderer.invoke(APP_DATA_CHANNELS.recentList);
      return result?.ok ? result.value : [];
    },
    open: async (id) => {
      const result = await ipcRenderer.invoke(APP_DATA_CHANNELS.recentOpen, { id });
      if (result?.ok) return result.value;
      return result?.code === 'protected-folder' ? 'protected-folder' : null; // S25.3
    },
    remove: async (id) => {
      await ipcRenderer.invoke(APP_DATA_CHANNELS.recentRemove, { id });
    },
  },
  lifecycle: {
    closeProject: (request) => ipcRenderer.invoke(APP_DATA_CHANNELS.closeProject, request),
  },
  session: {
    restore: () => ipcRenderer.invoke(APP_DATA_CHANNELS.sessionRestore),
    tabs: (request) => ipcRenderer.invoke(APP_DATA_CHANNELS.sessionTabs, request),
    saveTabs: (request) => ipcRenderer.invoke(APP_DATA_CHANNELS.sessionSaveTabs, request),
    saveLayout: (layout) => ipcRenderer.invoke(APP_DATA_CHANNELS.sessionSaveLayout, layout),
  },
  portability: {
    check: (request) => ipcRenderer.invoke(APP_DATA_CHANNELS.portabilityCheck, request),
  },
  // --- end S13 ---
  // --- S20.2 create-project wizard ---
  createProject: {
    options: (request) => ipcRenderer.invoke(CHANNELS.createProjectOptions, request),
    chooseLocation: () => ipcRenderer.invoke(CHANNELS.chooseProjectLocation),
    check: (request) => ipcRenderer.invoke(CHANNELS.checkProjectName, request),
    create: (request) => ipcRenderer.invoke(CHANNELS.createProject, request),
  },
  // --- end S20.2 ---
  // --- S21.3/S21.4 local history ---
  history: {
    files: (request) => ipcRenderer.invoke(CHANNELS.historyFiles, request),
    versions: (request) => ipcRenderer.invoke(CHANNELS.historyVersions, request),
    read: (request) => ipcRenderer.invoke(CHANNELS.historyRead, request),
    beforeRestore: (request) => ipcRenderer.invoke(CHANNELS.historyBeforeRestore, request),
    beforeFormat: (request) => ipcRenderer.invoke(CHANNELS.historyBeforeFormat, request),
    restoreDeleted: (request) => ipcRenderer.invoke(CHANNELS.historyRestoreDeleted, request),
    overview: (request) => ipcRenderer.invoke(CHANNELS.historyOverview, request),
    clear: (request) => ipcRenderer.invoke(CHANNELS.historyClear, request),
    cleanup: () => ipcRenderer.invoke(CHANNELS.historyCleanup),
    reveal: () => ipcRenderer.invoke(CHANNELS.historyReveal),
    groupBefore: (request) => ipcRenderer.invoke(CHANNELS.historyGroupBefore, request), // S34.2
    groupRecord: (request) => ipcRenderer.invoke(CHANNELS.historyGroupRecord, request),
    groups: (request) => ipcRenderer.invoke(CHANNELS.historyGroups, request),
    groupUndone: (request) => ipcRenderer.invoke(CHANNELS.historyGroupUndone, request),
  },
  // --- end S21.3/S21.4 ---
  // --- S24.2 native menus ---
  commands: {
    setContext: (context) => ipcRenderer.invoke(COMMAND_CHANNELS.setContext, context),
    onRun: (listener) => {
      const handler = (_event: unknown, id: unknown) => {
        if (isCommandId(id)) listener(id);
      };
      ipcRenderer.on(COMMAND_EVENTS.run, handler);
      return () => void ipcRenderer.removeListener(COMMAND_EVENTS.run, handler);
    },
  },
  // --- end S24.2 ---
  // S23 onboarding walkthrough
  walkthrough: {
    get: () => ipcRenderer.invoke(WALKTHROUGH_CHANNELS.get),
    save: (state) => ipcRenderer.invoke(WALKTHROUGH_CHANNELS.save, state),
  },
  // S16.2 runtime problems: the listener receives only the record list, never the IpcRendererEvent.
  problems: {
    list: () => ipcRenderer.invoke(PROBLEMS_CHANNELS.list),
    clearResolved: () => ipcRenderer.invoke(PROBLEMS_CHANNELS.clearResolved),
    onChanged: (listener) => {
      const wrapped = (_event: unknown, records: readonly ProblemRecord[]) => listener(records);
      ipcRenderer.on(PROBLEMS_EVENT_CHANNEL, wrapped);
      return () => void ipcRenderer.removeListener(PROBLEMS_EVENT_CHANNEL, wrapped);
    },
  },
  // S31 AI assistant: the listener receives only the event payload, never the IpcRendererEvent.
  ai: {
    status: (request) => ipcRenderer.invoke(AI_CHANNELS.status, request),
    setKey: (request) => ipcRenderer.invoke(AI_CHANNELS.setKey, request),
    clearKey: (request) => ipcRenderer.invoke(AI_CHANNELS.clearKey, request),
    testKey: (request) => ipcRenderer.invoke(AI_CHANNELS.testKey, request),
    listModels: (request) => ipcRenderer.invoke(AI_CHANNELS.listModels, request),
    setConfig: (request) => ipcRenderer.invoke(AI_CHANNELS.setConfig, request),
    setConsent: (request) => ipcRenderer.invoke(AI_CHANNELS.setConsent, request),
    request: (request) => ipcRenderer.invoke(AI_CHANNELS.request, request),
    cancel: (request) => ipcRenderer.invoke(AI_CHANNELS.cancel, request),
    resolveProposal: (decision) => ipcRenderer.invoke(AI_CHANNELS.resolveProposal, decision),
    previewSnapshot: (request) => ipcRenderer.invoke(AI_CHANNELS.previewSnapshot, request), // S38.2
    onEvent: (listener) => {
      const wrapped = (_event: unknown, payload: AiEvent) => listener(payload);
      ipcRenderer.on(AI_EVENT_CHANNEL, wrapped);
      return () => void ipcRenderer.removeListener(AI_EVENT_CHANNEL, wrapped);
    },
  },
  // S39: saved chats (app data) and token usage.
  aiHistory: {
    listChats: (request) => ipcRenderer.invoke(AI_HISTORY_CHANNELS.listChats, request),
    getChat: (request) => ipcRenderer.invoke(AI_HISTORY_CHANNELS.getChat, request),
    saveChat: (request) => ipcRenderer.invoke(AI_HISTORY_CHANNELS.saveChat, request),
    deleteChat: (request) => ipcRenderer.invoke(AI_HISTORY_CHANNELS.deleteChat, request),
    deleteProjectChats: (request) => ipcRenderer.invoke(AI_HISTORY_CHANNELS.deleteProjectChats, request),
    countRecentChats: (request) => ipcRenderer.invoke(AI_HISTORY_CHANNELS.countRecentChats, request),
    deleteRecentChats: (request) => ipcRenderer.invoke(AI_HISTORY_CHANNELS.deleteRecentChats, request),
    usage: () => ipcRenderer.invoke(AI_HISTORY_CHANNELS.usage),
    setDailyBudget: (request) => ipcRenderer.invoke(AI_HISTORY_CHANNELS.setDailyBudget, request),
  },
  // S41: preview annotations (decision 0030).
  annotations: {
    list: (request) => ipcRenderer.invoke(ANNOTATION_CHANNELS.list, request),
    pick: (request) => ipcRenderer.invoke(ANNOTATION_CHANNELS.pick, request),
    cancelPick: (request) => ipcRenderer.invoke(ANNOTATION_CHANNELS.cancelPick, request),
    candidates: (request) => ipcRenderer.invoke(ANNOTATION_CHANNELS.candidates, request),
    regionShot: (request) => ipcRenderer.invoke(ANNOTATION_CHANNELS.regionShot, request),
    resolve: (request) => ipcRenderer.invoke(ANNOTATION_CHANNELS.resolve, request),
    save: (request) => ipcRenderer.invoke(ANNOTATION_CHANNELS.save, request),
    update: (request) => ipcRenderer.invoke(ANNOTATION_CHANNELS.update, request),
    remove: (request) => ipcRenderer.invoke(ANNOTATION_CHANNELS.remove, request),
    highlight: (request) => ipcRenderer.invoke(ANNOTATION_CHANNELS.highlight, request),
    context: (request) => ipcRenderer.invoke(ANNOTATION_CHANNELS.context, request),
  },
  // S51.2: project search (find in files).
  search: {
    run: (request) => ipcRenderer.invoke(SEARCH_CHANNELS.run, request),
    cancel: (request) => ipcRenderer.invoke(SEARCH_CHANNELS.cancel, request),
  },
};

contextBridge.exposeInMainWorld(
  'noobide',
  Object.freeze({
    ...api,
    workspace: Object.freeze(api.workspace),
    preview: Object.freeze(api.preview),
    app: Object.freeze(api.app),
    recovery: Object.freeze(api.recovery),
    settings: Object.freeze(api.settings), // S13
    logs: Object.freeze(api.logs),
    projectConfig: Object.freeze(api.projectConfig),
    recentProjects: Object.freeze(api.recentProjects),
    lifecycle: Object.freeze(api.lifecycle),
    session: Object.freeze(api.session),
    createProject: Object.freeze(api.createProject), // S20.2
    history: Object.freeze(api.history), // S21.3/S21.4
    commands: Object.freeze(api.commands), // S24.2
    walkthrough: Object.freeze(api.walkthrough), // S23
    problems: Object.freeze(api.problems), // S16.2
    ai: Object.freeze(api.ai), // S31
    aiHistory: Object.freeze(api.aiHistory), // S39
    annotations: Object.freeze(api.annotations), // S41
    search: Object.freeze(api.search), // S51.2
  }),
);
