import { contextBridge, ipcRenderer } from 'electron';
import { CHANNELS, EVENTS, IPC_API_VERSION, type NoobideApi } from '../shared/ipc/contract';
import { platformId } from '../platform/index';

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
};

contextBridge.exposeInMainWorld(
  'noobide',
  Object.freeze({ ...api, workspace: Object.freeze(api.workspace), app: Object.freeze(api.app) }),
);
