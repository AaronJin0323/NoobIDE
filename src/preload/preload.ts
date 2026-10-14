import { contextBridge, ipcRenderer } from 'electron';
import { CHANNELS, IPC_API_VERSION, type NoobideApi } from '../shared/ipc/contract';
import { PREVIEW_CHANNELS, PREVIEW_EVENT_CHANNEL, type PreviewEvent } from '../shared/ipc/preview-contract';
import { platformId } from '../platform/index';

/**
 * Restricted bridge for the trusted workbench (sandboxed preload, S03.1). Exposes exactly the calls of the typed
 * contract in src/shared/ipc — never ipcRenderer itself, Node or a generic "send any channel" function. Main
 * validates every payload and sender again; this file only forwards.
 */
const api: NoobideApi = {
  apiVersion: IPC_API_VERSION,
  platform: platformId(),
  workspace: {
    openFolder: () => ipcRenderer.invoke(CHANNELS.openFolder),
    readFile: (request) => ipcRenderer.invoke(CHANNELS.readFile, request),
    writeFile: (request) => ipcRenderer.invoke(CHANNELS.writeFile, request),
    revealProject: (request) => ipcRenderer.invoke(CHANNELS.revealProject, request),
  },
  // S04.3 preview: the listener receives only the event payload, never the IpcRendererEvent (it exposes `sender`).
  preview: {
    start: (request) => ipcRenderer.invoke(PREVIEW_CHANNELS.start, request),
    stop: () => ipcRenderer.invoke(PREVIEW_CHANNELS.stop),
    reload: () => ipcRenderer.invoke(PREVIEW_CHANNELS.reload),
    setBounds: (bounds) => ipcRenderer.invoke(PREVIEW_CHANNELS.setBounds, bounds),
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
  },
  // --- end S12 ---
};

contextBridge.exposeInMainWorld(
  'noobide',
  Object.freeze({
    ...api,
    workspace: Object.freeze(api.workspace),
    preview: Object.freeze(api.preview),
    recovery: Object.freeze(api.recovery),
  }),
);
