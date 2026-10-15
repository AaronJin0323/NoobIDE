import type { PreviewLogEntry, PreviewStatus } from '../../shared/ipc/preview-contract';
import type { ProblemRecord } from '../../shared/problem';
import type { ProjectService } from '../../workspace/project-service';
import type { AgentProjectPorts } from './tools';

/**
 * Wires the agent's tool ports to main's existing services (S34.1): ProjectService for files (realpath containment,
 * links out of the project never followed, size and encoding limits), the problems bridge for runtime problems and
 * the PreviewManager for console records and refresh. No new file-system access path is created here.
 *
 * Structural types keep this module free of Electron imports (unit-testable); main passes the real objects:
 * `createProjectPorts({ projects, projectId, problems: problemsBridge.capture, preview: previewManager })`.
 */
export interface ProjectPortsDeps {
  readonly projects: Pick<ProjectService, 'listDir' | 'read' | 'rootOf'>;
  readonly projectId: string;
  readonly problems?: { list(): readonly ProblemRecord[] };
  readonly preview?: {
    getStatus(): PreviewStatus;
    reload(): PreviewStatus;
    recentRecords(): readonly PreviewLogEntry[];
  };
}

/** Null when the project is not open (the runner then reports `unknown-project`). */
export function createProjectPorts(deps: ProjectPortsDeps): AgentProjectPorts | null {
  const { projects, projectId, problems, preview } = deps;
  if (projects.rootOf(projectId) === undefined) return null;
  const previewOfProject = () => {
    const status = preview?.getStatus();
    return status && status.projectId === projectId && status.state !== 'stopped' ? status : null;
  };
  return {
    listDir: (relPath) => projects.listDir({ projectId, relPath }),
    readFile: (relPath) => projects.read({ projectId, relPath }),
    problems: () => (problems?.list() ?? []).filter((record) => record.projectId === projectId),
    consoleEntries: () => (previewOfProject() ? (preview?.recentRecords() ?? []) : []),
    refreshPreview: async () => {
      if (!preview || !previewOfProject()) return 'not-running';
      preview.reload();
      return 'refreshed';
    },
  };
}
