import { useEffect } from 'react';
import type { NoobideApi, OpenedProject } from '../../shared/ipc/contract';
import { MAX_LISTED_PATHS, ProjectIndex } from './project-index';

/**
 * S43.4: while a project is open, its files, ids, classes and indentation convention are indexed for the editor's
 * suggestions and indentation (project-index.ts). Monaco is reached through a dynamic import, like every other editor
 * module of the workbench.
 */
export function useProjectIndex(bridge: NoobideApi | undefined, project: OpenedProject | null): void {
  useEffect(() => {
    if (!bridge || !project) return undefined;
    const { projectId, rootPath } = project;
    let disposed = false;
    const index = new ProjectIndex({
      read: async (relPath) => {
        const result = await bridge.workspace.readFile({ projectId, relPath });
        return result.ok ? { text: result.value.text } : null;
      },
      // Files below a folder, breadth first, bounded like the index; null when relPath is not a folder.
      list: async (relPath) => {
        const first = await bridge.workspace.listDir({ projectId, relPath });
        if (!first.ok) return null;
        const files: string[] = [];
        const queue = [first.value];
        for (let listing = queue.shift(); listing && files.length < MAX_LISTED_PATHS; listing = queue.shift()) {
          for (const entry of listing.entries) {
            if (entry.name.startsWith('.')) continue;
            if (entry.kind === 'file') files.push(entry.relPath);
            else if (entry.kind === 'directory' && !disposed) {
              const next = await bridge.workspace.listDir({ projectId, relPath: entry.relPath });
              if (next.ok) queue.push(next.value);
            }
          }
        }
        return files;
      },
    });
    void index.open(project.files);
    void import('./smart-monaco').then(({ setSmartProject }) => {
      if (!disposed) setSmartProject({ index, rootPath });
    });
    const unsubscribe = bridge.workspace.onChanged((change) => {
      if (change.projectId === projectId) void index.changed(change.events);
    });
    return () => {
      disposed = true;
      unsubscribe();
      index.close();
      void import('./smart-monaco').then(({ setSmartProject }) => setSmartProject(null));
    };
  }, [bridge, project]);
}
