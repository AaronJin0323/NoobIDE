import type { PreviewStatus } from '../../shared/ipc/preview-contract';
import { capturePreview, previewOrigin, recordLocation, type PreviewSource } from '../preview-context';
import type { ProblemRecord } from '../../shared/problem';
import type { ProjectService } from '../../workspace/project-service';
import { err } from '../../shared/result';
import { relativeToRoot, resolveExisting } from '../../workspace/paths';
import { isHiddenForAgent, type AgentProjectPorts } from './tools';

/**
 * Wires the agent's tool ports to main's existing services (S34.1): ProjectService for files (realpath containment,
 * links out of the project never followed, size and encoding limits), the problems bridge for runtime problems and
 * the PreviewManager for console records, refresh and (S38.2) page snapshots. No new file-system access path is created here.
 *
 * Structural types keep this module free of Electron imports (unit-testable); main passes the real objects:
 * `createProjectPorts({ projects, projectId, problems: problemsBridge.capture, preview: previewManager })`.
 */
export interface ProjectPortsDeps {
  readonly projects: Pick<ProjectService, 'listDir' | 'read' | 'rootOf'>;
  readonly projectId: string;
  readonly problems?: { list(): readonly ProblemRecord[] };
  /** The PreviewManager: status, reload, recent records and (S38.1) page snapshots. */
  readonly preview?: PreviewSource & {
    reload(): PreviewStatus;
    isOwner?(requester: { readonly windowId: number; readonly projectId?: string }): boolean;
  };
  /** S38.2: the requesting window; with it, the preview tools only read a preview this window owns. */
  readonly owner?: number;
}

/** Null when the project is not open (the runner then reports `unknown-project`). */
export function createProjectPorts(deps: ProjectPortsDeps): AgentProjectPorts | null {
  const { projects, projectId, problems, preview, owner } = deps;
  if (projects.rootOf(projectId) === undefined) return null;
  const previewOfProject = () => {
    const status = preview?.getStatus();
    if (!status || status.projectId !== projectId || status.state === 'stopped') return null;
    if (owner !== undefined && preview?.isOwner && !preview.isOwner({ windowId: owner, projectId })) return null;
    return status;
  };
  /**
   * The hidden-file policy on the REAL location: an ordinary-looking name can be a link to `.env` or `.git`, and on
   * Windows a short name (`ENV~1`) reaches `.env`. The real path is taken relative to the root and checked again.
   */
  const hiddenBehind = async (relPath: string): Promise<boolean> => {
    const root = projects.rootOf(projectId);
    if (root === undefined) return true;
    if (relPath === '') return false;
    const resolved = await resolveExisting(root, relPath);
    if (!resolved.ok) return false; // the service reports it (not found / outside the project)
    const realRel = relativeToRoot(root, resolved.path);
    return realRel === null || isHiddenForAgent(realRel);
  };
  const hidden = () => err('outside-project' as const, 'hidden or ignored file');
  return {
    listDir: async (relPath) => ((await hiddenBehind(relPath)) ? hidden() : projects.listDir({ projectId, relPath })),
    readFile: async (relPath) => ((await hiddenBehind(relPath)) ? hidden() : projects.read({ projectId, relPath })),
    problems: () => (problems?.list() ?? []).filter((record) => record.projectId === projectId),
    consoleEntries: () => {
      const status = previewOfProject();
      if (!status || !preview) return [];
      const origin = previewOrigin(status);
      return preview.recentRecords().map((entry) => ({ entry, where: recordLocation(entry, origin) }));
    },
    previewSnapshot: async (options) =>
      preview && previewOfProject()
        ? capturePreview(preview, projectId, options)
        : err('not-running' as const, 'the preview of this project is not running'),
    refreshPreview: async () => {
      if (!preview || !previewOfProject()) return 'not-running';
      preview.reload();
      return 'refreshed';
    },
  };
}
