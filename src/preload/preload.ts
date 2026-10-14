import { contextBridge, ipcRenderer } from 'electron';
import { CHANNELS, IPC_API_VERSION, type NoobideApi } from '../shared/ipc/contract';
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
    // ── S07/S08: file tree, watcher and file operations ──
    listDir: (request) => ipcRenderer.invoke(CHANNELS.listDir, request),
  },
};

contextBridge.exposeInMainWorld('noobide', Object.freeze({ ...api, workspace: Object.freeze(api.workspace) }));
