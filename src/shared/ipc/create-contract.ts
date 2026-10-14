/**
 * Typed contract of the create-project wizard (S20.2). Pure TypeScript, shared by main, preload and renderer like
 * contract.ts. Same security rule: the renderer never sends an absolute path. Main shows the native folder dialog
 * (or picks the default location in Documents itself) and hands back an opaque `locationId`; the wizard sends that
 * id, a template id and the project name typed by the user.
 */
import { CHANNELS, isProjectId, type IpcResult, type OpenedProject } from './contract';

export const CREATE_CHANNELS = {
  options: CHANNELS.createProjectOptions,
  chooseLocation: CHANNELS.chooseProjectLocation,
  check: CHANNELS.checkProjectName,
  create: CHANNELS.createProject,
} as const;

export type TemplateLocaleText = Readonly<Record<'zh-CN' | 'en', string>>;

/** A built-in template as the wizard shows it. */
export interface TemplateSummary {
  readonly id: string;
  readonly default: boolean;
  readonly name: TemplateLocaleText;
  readonly description: TemplateLocaleText;
  /** Files the project will contain, `/`-separated (shown as "will create … index.html, style.css …"). */
  readonly files: readonly string[];
  readonly entry: string;
  /** The bundled SVG picture of the template as a `data:image/svg+xml` URL (img-src allows data:, offline). */
  readonly thumbnail: string;
}

/** A folder new projects can go into. `path` is for display only; requests use `locationId`. */
export interface ProjectLocation {
  readonly locationId: string;
  readonly path: string;
  /** The default location in Documents; it is created when the first project goes into it. */
  readonly isDefault: boolean;
}

export interface CreateProjectOptions {
  readonly templates: readonly TemplateSummary[];
  /** `null` when the Documents folder is not available; the user then chooses a location. */
  readonly location: ProjectLocation | null;
}

export interface NewProjectRequest {
  readonly locationId: string;
  readonly name: string;
}

export interface CreateProjectRequest extends NewProjectRequest {
  readonly templateId: string;
}

export interface CreatedProject {
  readonly project: OpenedProject;
  /** The template's entry page (relative path), opened in the editor and shown in the preview. */
  readonly entry: string;
}

export type CreateProjectError =
  | 'invalid-name'
  | 'exists'
  | 'case-conflict'
  | 'location-missing'
  | 'unknown-location'
  | 'unknown-template'
  | 'permission-denied'
  /** S25.3: blocked by the OS privacy protection (macOS TCC, Windows Controlled Folder Access). */
  | 'protected-folder'
  | 'disk-full'
  | 'template-broken'
  | 'create-failed'
  | 'list-failed';

export type TemplatesError = 'templates-unavailable';

export interface CreateProjectApi {
  /** Templates and the default location (folder name depends on the interface language). */
  options(request: { readonly locale: 'zh-CN' | 'en' }): Promise<IpcResult<CreateProjectOptions, TemplatesError>>;
  /** Native folder dialog; `null` when cancelled. */
  chooseLocation(): Promise<IpcResult<ProjectLocation | null, never>>;
  /** Live check of the name in a location; `folderPath` is the exact folder that would be created. */
  check(request: NewProjectRequest): Promise<IpcResult<{ folderPath: string }, CreateProjectError>>;
  /** Creates the folder from the template and opens it as the current project. */
  create(request: CreateProjectRequest): Promise<IpcResult<CreatedProject, CreateProjectError>>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const own = Object.keys(value);
  return own.length === keys.length && keys.every((k) => Object.hasOwn(value, k));
}

const TEMPLATE_ID = /^[a-z][a-z0-9-]{0,39}$/;
/** Longer than any valid name (255 UTF-8 bytes); the name rules themselves are checked in main. */
const MAX_NAME_LENGTH = 300;

export const isLocationId = isProjectId;

const isName = (value: unknown): value is string =>
  typeof value === 'string' && value.length <= MAX_NAME_LENGTH && !value.includes('\0');

export function parseOptionsRequest(payload: unknown): { locale: 'zh-CN' | 'en' } | null {
  if (!isRecord(payload) || !hasExactKeys(payload, ['locale'])) return null;
  return payload.locale === 'zh-CN' || payload.locale === 'en' ? { locale: payload.locale } : null;
}

export function parseNewProjectRequest(payload: unknown): NewProjectRequest | null {
  if (!isRecord(payload) || !hasExactKeys(payload, ['locationId', 'name'])) return null;
  const { locationId, name } = payload;
  return isLocationId(locationId) && isName(name) ? { locationId, name } : null;
}

export function parseCreateProjectRequest(payload: unknown): CreateProjectRequest | null {
  if (!isRecord(payload) || !hasExactKeys(payload, ['locationId', 'name', 'templateId'])) return null;
  const { locationId, name, templateId } = payload;
  if (!isLocationId(locationId) || !isName(name)) return null;
  return typeof templateId === 'string' && TEMPLATE_ID.test(templateId) ? { locationId, name, templateId } : null;
}
