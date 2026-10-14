# src/preload — restricted bridge

Exposes the typed API from src/shared/ipc to the **trusted workbench only** via contextBridge. The preview
(user webpage) gets **no** preload at all (PLAN §8).
