import { useEffect } from 'react';
import type { NoobideApi, OpenedProject } from '../../shared/ipc/contract';
import { ProjectIndex } from './project-index';

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
