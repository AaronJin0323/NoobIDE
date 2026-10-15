import { createHash } from 'node:crypto';
import { SerialQueue, writeFileAtomic, type RecoveryLogger } from '../recovery/atomic-file';
import { backupFile, readJsonFile, schemaVersionOf } from '../main/json-file';
import { AI_PROVIDERS, AI_PURPOSES, type AiConfig, type AiProviderId, type AiPurpose } from '../shared/ipc/ai-contract';
import { ANTHROPIC_DEFAULT_MODELS } from './providers/provider';

/**
 * AI settings and per-project consent in app data (S31.3, decision 0025). Never inside a project, never secrets.
 *
 * - `ai-config.json`: AI on/off (on by default — owner decision), the active provider, the model per purpose for each
 *   provider (switching provider keeps the other one's choices), inline completions on/off.
 * - `ai-consent.json`: projects whose code may be sent to the provider, remembered by a SHA-256 of their real root
 *   (like preview trust: the file holds no path text). Revocable.
 *
 * Both are versioned (schemaVersionOf): a corrupt file is backed up and reset, an unreadable one or one from a newer
 * NoobIDE (S28.4) is used read-only and never overwritten. Writes are serialized and atomic.
 */
export const AI_CONFIG_VERSION = 1;
export const AI_CONSENT_VERSION = 1;
export const MAX_CONSENTS = 500;

/** A model id as providers spell them; '' means "the default for this purpose". */
export const MODEL_ID = /^[\w.:/@-]{0,128}$/;

type ModelMap = Readonly<Record<AiPurpose, string>>;
const EMPTY_MODELS: ModelMap = { chat: '', agent: '', inline: '', edit: '' };

interface ConfigFile {
  readonly version: typeof AI_CONFIG_VERSION;
  readonly enabled: boolean;
  readonly provider: AiProviderId | null;
  readonly inlineCompletions: boolean;
  readonly models: Readonly<Record<AiProviderId, ModelMap>>;
}

export const DEFAULT_CONFIG_FILE: ConfigFile = {
  version: AI_CONFIG_VERSION,
  enabled: true,
  provider: null,
  inlineCompletions: true,
  models: { anthropic: ANTHROPIC_DEFAULT_MODELS, openai: EMPTY_MODELS },
};

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function parseModels(raw: unknown, fallback: ModelMap): ModelMap {
  if (!isRecord(raw)) return fallback;
  const out = { ...fallback };
  for (const purpose of AI_PURPOSES) {
    const value = raw[purpose];
    if (typeof value === 'string' && MODEL_ID.test(value)) out[purpose] = value;
  }
  return out;
}

/** Field by field; anything unknown or malformed takes its default. */
export function loadConfigFile(raw: unknown): ConfigFile {
  if (!isRecord(raw)) return DEFAULT_CONFIG_FILE;
  const models = isRecord(raw.models) ? raw.models : {};
  return {
    version: AI_CONFIG_VERSION,
    enabled: typeof raw.enabled === 'boolean' ? raw.enabled : DEFAULT_CONFIG_FILE.enabled,
    provider: AI_PROVIDERS.includes(raw.provider as AiProviderId) ? (raw.provider as AiProviderId) : null,
    inlineCompletions:
      typeof raw.inlineCompletions === 'boolean' ? raw.inlineCompletions : DEFAULT_CONFIG_FILE.inlineCompletions,
    models: {
      anthropic: parseModels(models.anthropic, DEFAULT_CONFIG_FILE.models.anthropic),
      openai: parseModels(models.openai, DEFAULT_CONFIG_FILE.models.openai),
    },
  };
}

/** The renderer's view: the models of the active provider (Anthropic defaults when none is chosen yet). */
export function configView(file: ConfigFile): AiConfig {
  return {
    enabled: file.enabled,
    provider: file.provider,
    models: file.models[file.provider ?? 'anthropic'],
    inlineCompletions: file.inlineCompletions,
  };
}

/** Small versioned JSON store with the shared app-data robustness rules. */
class VersionedJsonStore<T> {
  protected state: T;
  private loaded: Promise<void> | null = null;
  protected readonly queue = new SerialQueue();
  private writable = true;

  constructor(
    private readonly options: { readonly file: string; readonly log?: RecoveryLogger },
    private readonly name: string,
    private readonly version: number,
    initial: T,
    private readonly parse: (raw: unknown) => T,
  ) {
    this.state = initial;
  }

  protected read(): Promise<T> {
    this.load();
    return this.queue.run(async () => this.state);
  }

  protected change(update: (state: T) => T): Promise<T> {
    this.load();
    return this.queue.run(async () => {
      const next = update(this.state);
      if (next === this.state) return next;
      this.state = next;
      if (!this.writable) return next;
      try {
        await writeFileAtomic(this.options.file, `${JSON.stringify(next, null, 2)}\n`);
      } catch (e) {
        this.options.log?.(`${this.name}-write-failed`, { code: (e as { code?: string }).code ?? 'unknown' });
      }
      return next;
    });
  }

  private load(): void {
    this.loaded ??= this.queue.run(async () => {
      const read = await readJsonFile(this.options.file);
      if (read.kind === 'parsed') {
        this.state = this.parse(read.value);
        if (schemaVersionOf(read.value, this.version).kind === 'newer') {
          // S28.4 downgrade: use it, never write it (changes last until the app quits).
          this.writable = false;
          this.options.log?.(`${this.name}-newer-version`, { readOnly: true });
        }
      } else if (read.kind === 'unreadable') {
        this.writable = false;
        this.options.log?.(`${this.name}-unreadable`, { code: read.code });
      } else if (read.kind === 'corrupt') {
        const backup = await backupFile(this.options.file, 'corrupt');
        if (backup === null) this.writable = false;
        this.options.log?.(`${this.name}-reset`, { backedUp: backup !== null });
      }
    });
  }
}

export class AiConfigStore extends VersionedJsonStore<ConfigFile> {
  constructor(options: { readonly file: string; readonly log?: RecoveryLogger }) {
    super(options, 'ai-config', AI_CONFIG_VERSION, DEFAULT_CONFIG_FILE, loadConfigFile);
  }

  async get(): Promise<AiConfig> {
    return configView(await this.read());
  }

  /** The stored model per purpose of one provider ('' = not chosen yet). */
  async modelsOf(provider: AiProviderId): Promise<ModelMap> {
    return (await this.read()).models[provider];
  }

  /** Applies the renderer's config; its models belong to the provider it names. */
  async set(config: AiConfig): Promise<AiConfig> {
    const next = await this.change((state) => ({
      ...state,
      enabled: config.enabled,
      provider: config.provider,
      inlineCompletions: config.inlineCompletions,
      models: config.provider ? { ...state.models, [config.provider]: { ...config.models } } : state.models,
    }));
    return configView(next);
  }

  /** First key stored: that provider becomes the active one (unless one was chosen already). */
  async adoptProvider(provider: AiProviderId): Promise<void> {
    await this.change((state) => (state.provider === null ? { ...state, provider } : state));
  }

  /** Fills models not chosen yet (OpenAI defaults picked from its model list). */
  async fillModels(provider: AiProviderId, defaults: ModelMap): Promise<ModelMap> {
    const next = await this.change((state) => {
      const current = state.models[provider];
      if (AI_PURPOSES.every((p) => current[p] !== '')) return state;
      const filled = { ...current };
      for (const p of AI_PURPOSES) if (filled[p] === '') filled[p] = defaults[p];
      return { ...state, models: { ...state.models, [provider]: filled } };
    });
    return next.models[provider];
  }
}

// --- consent ---

interface ConsentFile {
  readonly version: typeof AI_CONSENT_VERSION;
  /** Hashes of allowed project roots, oldest first. */
  readonly allowed: readonly string[];
}

const HASH = /^[0-9a-f]{64}$/;

export function consentKey(realRoot: string): string {
  return createHash('sha256').update(`noobide-ai-consent:${realRoot}`, 'utf8').digest('hex');
}

function loadConsentFile(raw: unknown): ConsentFile {
  const allowed =
    isRecord(raw) && Array.isArray(raw.allowed)
      ? raw.allowed.filter((h): h is string => typeof h === 'string' && HASH.test(h)).slice(-MAX_CONSENTS)
      : [];
  return { version: AI_CONSENT_VERSION, allowed: [...new Set(allowed)] };
}

export class AiConsentStore extends VersionedJsonStore<ConsentFile> {
  constructor(options: { readonly file: string; readonly log?: RecoveryLogger }) {
    super(options, 'ai-consent', AI_CONSENT_VERSION, { version: AI_CONSENT_VERSION, allowed: [] }, loadConsentFile);
  }

  async isAllowed(realRoot: string): Promise<boolean> {
    return (await this.read()).allowed.includes(consentKey(realRoot));
  }

  async set(realRoot: string, allowed: boolean): Promise<void> {
    const key = consentKey(realRoot);
    await this.change((state) => {
      const has = state.allowed.includes(key);
      if (allowed === has) return state;
      return {
        ...state,
        allowed: allowed ? [...state.allowed, key].slice(-MAX_CONSENTS) : state.allowed.filter((k) => k !== key),
      };
    });
  }
}
