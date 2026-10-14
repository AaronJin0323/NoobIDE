import type { NoobideApi, OpenedProject, RequestError } from '../../shared/ipc/contract';
import type { CreateProjectError, TemplatesError } from '../../shared/ipc/create-contract';
import type { MessageKey } from '../i18n/index';
import { fill, nameProblemMessage, type Translate } from '../workbench/file-op-messages';

/**
 * Pure view logic of the welcome screen and the create-project wizard (S20.2). Text comes from the i18n
 * dictionaries; this module decides which message, which state and which actions are offered.
 */

// ── Recent projects ───────────────────────────────────────────────────────────────────────────────────────────

/** One entry of the recent-projects list, as the settings store (S13.3) provides it. */
export interface RecentProject {
  /** Opaque id; the renderer never handles the project's absolute path except to show it. */
  readonly id: string;
  readonly name: string;
  /** Full real path, shown under the name (paths with Chinese characters and spaces). */
  readonly path: string;
  /** False when the folder no longer exists (moved, deleted, unplugged drive). */
  readonly available: boolean;
}

/**
 * What the welcome screen needs from the recent-projects store. Persisting the list belongs to S13.3 (versioned
 * app settings); the welcome screen shows the list only when the bridge provides this API (feature detection), so
 * there is never a second settings store.
 */
export interface RecentProjectsSource {
  list(): Promise<readonly RecentProject[]>;
  /** Opens the project (main looks its path up by id); `null` when the folder cannot be opened. */
  open(id: string): Promise<OpenedProject | null>;
  /** Removes the entry from the list only. Never touches anything on disk. */
  remove(id: string): Promise<void>;
}

/** The bridge's recent-projects API, when this build has one (S13.3 adds `recentProjects`). */
export function recentProjectsSource(bridge: NoobideApi | undefined): RecentProjectsSource | undefined {
  const candidate = (bridge as { recentProjects?: Partial<RecentProjectsSource> } | undefined)?.recentProjects;
  if (!candidate) return undefined;
  const { list, open, remove } = candidate;
  return typeof list === 'function' && typeof open === 'function' && typeof remove === 'function'
    ? (candidate as RecentProjectsSource)
    : undefined;
}

export interface RecentRowView {
  /** Shown as text next to the warning icon (never colour alone). */
  readonly statusKey: MessageKey | null;
  /** A missing folder can only be removed from the list; an available one is opened. */
  readonly action: 'open' | 'remove';
  readonly actionKey: MessageKey;
}

export function recentRowView(project: RecentProject): RecentRowView {
  return project.available
    ? { statusKey: null, action: 'open', actionKey: 'welcome.recentOpen' }
    : { statusKey: 'welcome.recentMissing', action: 'remove', actionKey: 'welcome.recentRemove' };
}

// ── Create wizard ───────────────────────────────────────────────────────────────────────────────────────────

/** The result of the live name check in main for the current name + location. */
export type NameCheck =
  | { readonly state: 'idle' }
  | { readonly state: 'checking' }
  | { readonly state: 'ok'; readonly folderPath: string }
  | { readonly state: 'error'; readonly code: CreateProjectError | RequestError; readonly message: string };

export interface WizardInput {
  readonly templateId: string | null;
  readonly name: string;
  readonly hasLocation: boolean;
  readonly check: NameCheck;
  readonly creating: boolean;
}

export interface WizardView {
  /** Why "Create and open" is not possible right now, or what is being checked; null when all is fine. */
  readonly message: string | null;
  readonly messageKind: 'error' | 'progress' | null;
  /** The exact folder that will be created, once main confirmed it is free. */
  readonly folderPath: string | null;
  readonly canCreate: boolean;
}

/** The explanation for a refused name, location or failed create. `message` is main's detail (e.g. a name). */
export function createErrorMessage(
  t: Translate,
  code: CreateProjectError | TemplatesError | RequestError,
  message: string,
  name: string,
): string {
  switch (code) {
    case 'invalid-name':
      return nameProblemMessage(t, name) ?? t('wizard.error.generic');
    case 'exists':
      return fill(t('wizard.error.exists'), { name: message || name });
    case 'case-conflict':
      return fill(t('wizard.error.caseConflict'), { name: message });
    case 'location-missing':
    case 'unknown-location':
      return t('wizard.error.locationMissing');
    case 'permission-denied':
      return t('wizard.error.permission');
    case 'disk-full':
      return t('wizard.error.diskFull');
    case 'template-broken':
    case 'unknown-template':
      return t('wizard.error.templateBroken');
    case 'templates-unavailable':
      return t('wizard.error.templatesUnavailable');
    default:
      return t('wizard.error.generic');
  }
}

/**
 * Name rules are checked immediately in the renderer (same rules as main: src/shared/file-names); collisions need
 * the disk and come from main's check. Create is possible only when both agree and nothing is in progress.
 */
export function wizardView(t: Translate, input: WizardInput): WizardView {
  const local = nameProblemMessage(t, input.name);
  if (local !== null) return { message: local, messageKind: 'error', folderPath: null, canCreate: false };
  if (!input.hasLocation) {
    return { message: t('wizard.noLocation'), messageKind: 'error', folderPath: null, canCreate: false };
  }
  const { check } = input;
  if (check.state === 'error') {
    return {
      message: createErrorMessage(t, check.code, check.message, input.name),
      messageKind: 'error',
      folderPath: null,
      canCreate: false,
    };
  }
  if (check.state !== 'ok') {
    return { message: t('wizard.checking'), messageKind: 'progress', folderPath: null, canCreate: false };
  }
  return {
    message: input.creating ? t('wizard.creating') : null,
    messageKind: input.creating ? 'progress' : null,
    folderPath: check.folderPath,
    canCreate: input.templateId !== null && !input.creating,
  };
}

/** "index.html、style.css、script.js、images/" — top-level files and folders of a template, in manifest order. */
export function topLevelEntries(files: readonly string[]): string[] {
  const out: string[] = [];
  for (const file of files) {
    const slash = file.indexOf('/');
    const entry = slash < 0 ? file : `${file.slice(0, slash)}/`;
    if (!out.includes(entry)) out.push(entry);
  }
  return out;
}
