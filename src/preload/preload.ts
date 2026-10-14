import { contextBridge } from 'electron';

/**
 * Restricted bridge for the trusted workbench (sandboxed preload). S03.1 replaces this placeholder with the typed,
 * validated API from src/shared/ipc. Nothing here exposes Node, ipcRenderer or filesystem access.
 */
contextBridge.exposeInMainWorld('noobide', Object.freeze({ apiVersion: 0 }));
