import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { IpcMainInvokeEvent } from 'electron';
import { parseNoPayload, toIpcResult, type IpcResult } from '../shared/ipc/contract';
import {
  CREATE_CHANNELS,
  parseCreateProjectRequest,
  parseNewProjectRequest,
  parseOptionsRequest,
  type CreateProjectError,
  type CreateProjectOptions,
  type ProjectLocation,
  type TemplateSummary,
  type TemplatesError,
} from '../shared/ipc/create-contract';
import { checkNewProject, createProjectFromTemplate } from '../workspace/create-project';
import { listTemplates, type TemplateInfo } from '../workspace/templates';
import type { ProjectService } from '../workspace/project-service';
import type { HandleFn } from './ipc';

/**
 * Handlers of the create-project wizard (S20.2), registered through ipc.ts's `handle` (sender + payload checks run
 * first). Locations are absolute paths that only main knows: the default one it derives from the Documents folder,
 * and folders the user picked in the native dialog. The renderer refers to them by an opaque id.
 */
export interface CreateProjectPort {
  /** Folder holding the built-in templates (resolveTemplatesDir). */
  readonly templatesDir: string;
  /** The user's Documents folder; throws or returns null when unavailable. */
  documentsDir(): string | null;
  /** Native folder dialog for "Change…"; `null` when cancelled. */
  chooseFolder(event: IpcMainInvokeEvent, defaultPath: string | undefined): Promise<string | null>;
}

/** Default location folder inside Documents, named in the interface language (wireframe welcome 1b). */
export const DEFAULT_LOCATION_NAMES = { 'zh-CN': 'NoobIDE 项目', en: 'NoobIDE Projects' } as const;

interface KnownLocation {
  readonly path: string;
  readonly isDefault: boolean;
}

export class ProjectCreator {
  private readonly locations = new Map<string, KnownLocation>();
  private templates: readonly TemplateInfo[] | null = null;

  constructor(private readonly port: CreateProjectPort) {}

  location(id: string): KnownLocation | undefined {
    return this.locations.get(id);
  }

  remember(location: KnownLocation): ProjectLocation {
    for (const [id, known] of this.locations) {
      if (known.path === location.path && known.isDefault === location.isDefault) {
        return { locationId: id, ...known };
      }
    }
    const locationId = randomUUID();
    this.locations.set(locationId, location);
    return { locationId, ...location };
  }

  async loadTemplates(): Promise<readonly TemplateInfo[] | null> {
    if (this.templates) return this.templates;
    const listing = await listTemplates(this.port.templatesDir);
    if (!listing.ok || listing.value.templates.length === 0) return null;
    this.templates = listing.value.templates;
    return this.templates;
  }

  defaultLocation(locale: 'zh-CN' | 'en'): ProjectLocation | null {
    let documents: string | null;
    try {
      documents = this.port.documentsDir();
    } catch {
      documents = null;
    }
    if (!documents) return null;
    return this.remember({ path: path.join(documents, DEFAULT_LOCATION_NAMES[locale]), isDefault: true });
  }
}

async function summary(template: TemplateInfo): Promise<TemplateSummary> {
  let thumbnail = '';
  try {
    const svg = await readFile(path.join(template.dir, ...template.thumbnail.split('/')));
    thumbnail = `data:image/svg+xml;base64,${svg.toString('base64')}`;
  } catch {
    // The wizard shows the name and description without a picture.
  }
  return {
    id: template.id,
    default: template.default,
    name: template.name,
    description: template.description,
    files: template.files,
    entry: template.entry,
    thumbnail,
  };
}

/** Without a port (tests, tools) every channel is still registered and answers "unavailable". */
export function registerCreateProjectHandlers(
  handle: HandleFn,
  projects: Pick<ProjectService, 'open'>,
  port: CreateProjectPort | undefined,
  projectOpened?: (projectId: string, root: string, sender: IpcMainInvokeEvent['sender']) => void,
): void {
  const creator = new ProjectCreator(
    port ?? { templatesDir: '', documentsDir: () => null, chooseFolder: async () => null },
  );
  handle(
    CREATE_CHANNELS.options,
    parseOptionsRequest,
    async ({ locale }): Promise<IpcResult<CreateProjectOptions, TemplatesError>> => {
      const templates = port ? await creator.loadTemplates() : null;
      if (!templates) return { ok: false, code: 'templates-unavailable', message: 'no valid template found' };
      return {
        ok: true,
        value: { templates: await Promise.all(templates.map(summary)), location: creator.defaultLocation(locale) },
      };
    },
  );

  handle(CREATE_CHANNELS.chooseLocation, parseNoPayload, async (_payload, event) => {
    if (!port) return { ok: true, value: null };
    let documents: string | undefined;
    try {
      documents = port.documentsDir() ?? undefined;
    } catch {
      documents = undefined;
    }
    const chosen = await port.chooseFolder(event, documents);
    return { ok: true, value: chosen === null ? null : creator.remember({ path: chosen, isDefault: false }) };
  });

  const unknownLocation = { ok: false, code: 'unknown-location', message: 'location was not chosen here' } as const;

  handle(CREATE_CHANNELS.check, parseNewProjectRequest, async ({ locationId, name }) => {
    const location = creator.location(locationId);
    if (!location) return unknownLocation;
    return toIpcResult(
      await checkNewProject({ parentDir: location.path, name }, { createParent: location.isDefault }),
    ) as IpcResult<{ folderPath: string }, CreateProjectError>;
  });

  handle(CREATE_CHANNELS.create, parseCreateProjectRequest, async ({ locationId, name, templateId }, event) => {
    const location = creator.location(locationId);
    if (!location) return unknownLocation;
    const template = (await creator.loadTemplates())?.find((t) => t.id === templateId);
    if (!template) return { ok: false, code: 'unknown-template', message: templateId };
    const created = await createProjectFromTemplate(
      template,
      { parentDir: location.path, name },
      { createParent: location.isDefault },
    );
    if (!created.ok) return toIpcResult(created);
    const opened = await projects.open(created.value.root);
    if (!opened.ok) return toIpcResult(opened);
    projectOpened?.(opened.value.projectId, opened.value.rootPath, event.sender);
    return { ok: true, value: { project: opened.value, entry: template.entry } };
  });
}
