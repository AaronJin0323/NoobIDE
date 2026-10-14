# src/main — Electron main process

Windows, application lifecycle, IPC handlers, wiring of services. Thin: business logic lives in workspace/, preview/,
diagnostics/, recovery/. Every IPC handler validates its payload and sender (see src/shared/ipc, feature S03.1).
