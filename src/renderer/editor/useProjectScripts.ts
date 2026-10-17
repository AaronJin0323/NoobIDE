import { useEffect } from 'react';
import type { NoobideApi, OpenedProject } from '../../shared/ipc/contract';
import type { ProjectScripts } from './project-scripts';
import { cancelExpectedProjectScripts, expectProjectScripts } from './project-scripts-registry';

/**
 * S18.4: while a project is open, its other JavaScript files are known to the JavaScript language service (see
 * project-scripts.ts). Monaco is reached through a dynamic import, like every other editor module of the workbench.
 * S57: the registry is told at once that an instance is coming, so navigation pressed before the import resolves
 * waits for it (project-scripts-registry.ts).
 */
export function useProjectScripts(bridge: NoobideApi | undefined, project: OpenedProject | null): void {
  useEffect(() => {
    if (!bridge || !project) return undefined;
    const { projectId } = project;
    let disposed = false;
    let instance: { scripts: ProjectScripts; dispose(): void } | null = null;
    expectProjectScripts();
    import('./project-scripts-monaco')
      .then(({ createProjectScripts }) => {
        if (disposed) return;
        instance = createProjectScripts(async (relPath) => {
          const result = await bridge.workspace.readFile({ projectId, relPath });
          return result.ok ? { text: result.value.text, uri: result.value.uri } : null;
        }, project.files);
      })
      .catch(() => cancelExpectedProjectScripts()); // no binding will come: navigation must not wait for one
    const unsubscribe = bridge.workspace.onChanged((change) => {
      if (change.projectId === projectId) void instance?.scripts.changed(change.events);
    });
    return () => {
      disposed = true;
      unsubscribe();
      if (instance) instance.dispose();
      else cancelExpectedProjectScripts();
    };
  }, [bridge, project]);
}
