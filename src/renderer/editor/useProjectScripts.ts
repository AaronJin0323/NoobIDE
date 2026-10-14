import { useEffect } from 'react';
import type { NoobideApi, OpenedProject } from '../../shared/ipc/contract';
import type { ProjectScripts } from './project-scripts';

/**
 * S18.4: while a project is open, its other JavaScript files are known to the JavaScript language service (see
 * project-scripts.ts). Monaco is reached through a dynamic import, like every other editor module of the workbench.
 */
export function useProjectScripts(bridge: NoobideApi | undefined, project: OpenedProject | null): void {
  useEffect(() => {
    if (!bridge || !project) return undefined;
    const { projectId } = project;
    let disposed = false;
    let instance: { scripts: ProjectScripts; dispose(): void } | null = null;
    void import('./project-scripts-monaco').then(({ createProjectScripts }) => {
      if (disposed) return;
      instance = createProjectScripts(async (relPath) => {
        const result = await bridge.workspace.readFile({ projectId, relPath });
        return result.ok ? { text: result.value.text, uri: result.value.uri } : null;
      });
      void instance.scripts.open(project.files);
    });
    const unsubscribe = bridge.workspace.onChanged((change) => {
      if (change.projectId === projectId) void instance?.scripts.changed(change.events);
    });
    return () => {
      disposed = true;
      unsubscribe();
      instance?.dispose();
    };
  }, [bridge, project]);
}
