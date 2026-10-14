import { useEffect, useRef, useState } from 'react';
import type { ProblemRecord } from '../../shared/problem';
import { StaticProblems } from './static-problems';

/** e2e: the static records currently published (like main's __noobideTestHooks; metadata only). */
const testHooks: { static: readonly ProblemRecord[] } = { static: [] };
if (typeof window !== 'undefined' && !('__noobideProblemsTestHooks' in window)) {
  Object.defineProperty(window, '__noobideProblemsTestHooks', { value: testHooks });
}

export interface OpenFileRef {
  readonly relPath: string;
  /** The workbench's model URI (OpenTab.uri). */
  readonly uri: string;
}

export interface StaticProblemsHandle {
  readonly records: readonly ProblemRecord[];
  /** Re-reads every open file's markers and publishes at once (a re-check before deciding "resolved", S22.5). */
  recheck(): void;
}

/**
 * S19.1: static problems of the open project's open files, from the language services' markers. Monaco is loaded
 * through a dynamic import, like every other editor module the workbench uses.
 */
export function useStaticProblems(projectId: string | null, openFiles: readonly OpenFileRef[]): StaticProblemsHandle {
  const [records, setRecords] = useState<readonly ProblemRecord[]>([]);
  const files = useRef(openFiles);
  files.current = openFiles;
  const live = useRef<{ problems: StaticProblems; refreshAll(): void } | null>(null);
  // Read-only view for the e2e suite (records hold language-service messages and positions, never file contents).
  useEffect(() => {
    testHooks.static = records;
  }, [records]);

  useEffect(() => {
    setRecords([]);
    if (!projectId) return undefined;
    const problems = new StaticProblems({ projectId, onChange: setRecords });
    let disposed = false;
    let watcher: { refreshAll(): void; dispose(): void } | null = null;
    void import('./static-problems-monaco').then(({ watchMarkers, monacoKey }) => {
      if (disposed) return;
      const relPathOf = (monacoUri: string) => files.current.find((f) => monacoKey(f.uri) === monacoUri)?.relPath;
      watcher = watchMarkers(problems, relPathOf);
      live.current = { problems, refreshAll: watcher.refreshAll };
    });
    return () => {
      disposed = true;
      live.current = null;
      watcher?.dispose();
      problems.dispose();
    };
  }, [projectId]);

  // Tabs opened or closed: closed files lose their records; newly opened files may already have markers.
  const key = openFiles.map((f) => f.relPath).join('\n');
  useEffect(() => {
    const current = live.current;
    if (!current) return;
    current.problems.retain(files.current.map((f) => f.relPath));
    current.refreshAll();
  }, [key]);

  return {
    records,
    recheck: () => {
      const current = live.current;
      if (!current) return;
      current.refreshAll();
      current.problems.flush();
    },
  };
}
