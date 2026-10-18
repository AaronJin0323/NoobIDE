/**
 * Monaco's TypeScript WorkerManager (private API, no types shipped). Used only by the S59.5 idle stop
 * (ts-idle-stop.ts), which checks the members at runtime and is pinned against the installed source by its test.
 * Mirrors `TsWorkerManagerLike` there (an ambient module cannot import a relative path).
 */
declare module 'monaco-editor/languages/features/typescript/workerManager' {
  export const WorkerManager:
    | {
        prototype: {
          getLanguageServiceWorker?(...resources: unknown[]): Promise<unknown>;
          _stopWorker?(): void;
          _worker?: unknown;
        };
      }
    | undefined;
}
