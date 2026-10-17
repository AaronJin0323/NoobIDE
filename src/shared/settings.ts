/**
 * App settings schema (S13.1, PLAN §6 "shared: settings schemas"). Pure TypeScript: used by main (the store in app
 * data validates, migrates and writes it) and the renderer (types, the patch it may send).
 *
 * Every settings file carries a `version`. Loading runs the migrations from the file's version up to
 * {@link SETTINGS_VERSION}; each field is then validated on its own and an invalid or missing field takes its default,
 * so one bad value never resets the others. A file that is not a JSON object at all, or comes from a newer NoobIDE,
 * is not guessed at: the store backs it up and starts from the defaults.
 */
export const SETTINGS_VERSION = 1;

/** Interface languages (must match src/renderer/i18n LOCALES; a unit test checks). zh-CN is the default. */
export const SETTINGS_LOCALES = ['zh-CN', 'en'] as const;
export type SettingsLocale = (typeof SETTINGS_LOCALES)[number];

/** Colour theme choice (S24.4: chosen from the command menu or the View menu). */
export const THEME_CHOICES = ['system', 'light', 'dark'] as const;
export type ThemeChoice = (typeof THEME_CHOICES)[number];

/** S50.4: interface density (View menu and the command palette): 32px or 28px controls and rows. */
export const DENSITY_CHOICES = ['comfortable', 'compact'] as const;
export type DensityChoice = (typeof DENSITY_CHOICES)[number];

export const EDITOR_FONT_SIZE = { min: 10, max: 32, default: 16 } as const;

/** S49.5: how many commands run from the palette it remembers (newest first). */
export const PALETTE_RECENTS_MAX = 8;

export interface AppSettings {
  readonly version: typeof SETTINGS_VERSION;
  readonly locale: SettingsLocale;
  readonly theme: ThemeChoice;
  /** S50.4: comfortable (default) or compact controls and rows. */
  readonly density: DensityChoice;
  /** Code font size in px (PLAN §3: start at about 16px). */
  readonly editorFontSize: number;
  /** Reopen the last project, its tabs and the layout on a normal start (S13.4). */
  readonly restoreSession: boolean;
  /** S53.1: Tab expands Emmet abbreviations in HTML and CSS (Edit menu → Emmet abbreviations on Tab). */
  readonly emmet: boolean;
  /** S53.1: the one-time status-bar hint after the first expansion has been shown. */
  readonly emmetHintShown: boolean;
  /** S53.4: an explicit save formats the file first (off by default). */
  readonly formatOnSave: boolean;
  /**
   * S49.5: command ids last run from the command palette, newest first, at most PALETTE_RECENTS_MAX. Per user (app
   * data), never in a project. Ids this version does not know are kept here and skipped by the palette.
   */
  readonly paletteRecents: readonly string[];
}

export const DEFAULT_SETTINGS: AppSettings = {
  version: SETTINGS_VERSION,
  locale: 'zh-CN',
  theme: 'system',
  density: 'comfortable',
  editorFontSize: EDITOR_FONT_SIZE.default,
  restoreSession: true,
  emmet: true,
  emmetHintShown: false,
  formatOnSave: false,
  paletteRecents: [],
};

/** What the renderer may change. Validated field by field in main (parseSettingsPatch). */
export type SettingsPatch = Partial<Omit<AppSettings, 'version'>>;

type Raw = Record<string, unknown>;

/** One step of the migration chain: turns a file of version `from` into version `from + 1`. */
export interface SettingsMigration {
  readonly from: number;
  migrate(raw: Raw): Raw;
}

/**
 * The real chain. Version 0 is a settings object without a `version` field (written before settings were
 * versioned): it keeps every field that is still valid and gets version 1.
 */
export const SETTINGS_MIGRATIONS: readonly SettingsMigration[] = [
  { from: 0, migrate: (raw) => ({ ...raw, version: 1 }) },
];

export type LoadedSettings =
  | {
      readonly ok: true;
      readonly settings: AppSettings;
      /** The file's version when a migration ran (it should be written back), else null. */
      readonly migratedFrom: number | null;
      /** Fields that were invalid and took their default. */
      readonly resetFields: readonly string[];
    }
  | { readonly ok: false; readonly reason: 'not-an-object' | 'newer-version' | 'bad-version' | 'migration-failed' };

const isRecord = (value: unknown): value is Raw => typeof value === 'object' && value !== null && !Array.isArray(value);

/** Validates and migrates a parsed settings file. Never throws. */
export function upgradeSettings(
  parsed: unknown,
  migrations: readonly SettingsMigration[] = SETTINGS_MIGRATIONS,
  targetVersion: number = SETTINGS_VERSION,
): LoadedSettings {
  if (!isRecord(parsed)) return { ok: false, reason: 'not-an-object' };
  const declared = parsed.version;
  const version = declared === undefined ? 0 : declared;
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 0) {
    return { ok: false, reason: 'bad-version' };
  }
  if (version > targetVersion) return { ok: false, reason: 'newer-version' };
  let raw: Raw = parsed;
  try {
    for (let v = version; v < targetVersion; v += 1) {
      const step = migrations.find((m) => m.from === v);
      if (!step) return { ok: false, reason: 'migration-failed' };
      raw = step.migrate(raw);
      if (!isRecord(raw) || raw.version !== v + 1) return { ok: false, reason: 'migration-failed' };
    }
  } catch {
    return { ok: false, reason: 'migration-failed' };
  }
  const { settings, resetFields } = pickSettings(raw);
  return { ok: true, settings, migratedFrom: version === targetVersion ? null : version, resetFields };
}

/** Every known field that is valid; an invalid or missing one takes its default. Unknown fields are ignored. */
function pickSettings(raw: Raw): { settings: AppSettings; resetFields: string[] } {
  const resetFields: string[] = [];
  const pick = <K extends keyof SettingsPatch>(key: K, valid: (value: unknown) => boolean): AppSettings[K] => {
    if (Object.hasOwn(raw, key) && valid(raw[key])) return raw[key] as AppSettings[K];
    if (Object.hasOwn(raw, key)) resetFields.push(key);
    return DEFAULT_SETTINGS[key];
  };
  const settings: AppSettings = {
    version: SETTINGS_VERSION,
    locale: pick('locale', isSettingsLocale),
    theme: pick('theme', isThemeChoice),
    density: pick('density', isDensityChoice),
    editorFontSize: pick('editorFontSize', isFontSize),
    restoreSession: pick('restoreSession', isBoolean),
    emmet: pick('emmet', isBoolean),
    emmetHintShown: pick('emmetHintShown', isBoolean),
    formatOnSave: pick('formatOnSave', isBoolean),
    paletteRecents: pick('paletteRecents', isPaletteRecents),
  };
  return { settings, resetFields };
}

/**
 * S28.4 downgrade: a settings file written by a newer NoobIDE (`upgradeSettings` says `newer-version`). The fields
 * this version knows are used as far as they are valid; the file itself is left alone (the store does not write it).
 */
export function readNewerSettings(parsed: unknown): AppSettings {
  return isRecord(parsed) ? pickSettings(parsed).settings : DEFAULT_SETTINGS;
}

export function isSettingsLocale(value: unknown): value is SettingsLocale {
  return typeof value === 'string' && (SETTINGS_LOCALES as readonly string[]).includes(value);
}

export function isThemeChoice(value: unknown): value is ThemeChoice {
  return typeof value === 'string' && (THEME_CHOICES as readonly string[]).includes(value);
}

export function isDensityChoice(value: unknown): value is DensityChoice {
  return typeof value === 'string' && (DENSITY_CHOICES as readonly string[]).includes(value);
}

const isBoolean = (value: unknown): value is boolean => typeof value === 'boolean';

/** S49.5: a short list of distinct command-id-shaped strings (`toggle-problems`); the registry check is the palette's. */
export function isPaletteRecents(value: unknown): value is readonly string[] {
  return (
    Array.isArray(value) &&
    value.length <= PALETTE_RECENTS_MAX &&
    value.every((id) => typeof id === 'string' && /^[a-z0-9][a-z0-9-]{0,63}$/.test(id)) &&
    new Set(value).size === value.length
  );
}

/** Settings that are plain on/off switches. */
const BOOLEAN_KEYS: readonly string[] = ['restoreSession', 'emmet', 'emmetHintShown', 'formatOnSave'];

function isFontSize(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= EDITOR_FONT_SIZE.min &&
    value <= EDITOR_FONT_SIZE.max
  );
}

/** IPC payload check: a non-empty object with only known keys, each valid. Anything else is rejected. */
export function parseSettingsPatch(payload: unknown): SettingsPatch | null {
  if (!isRecord(payload)) return null;
  const keys = Object.keys(payload);
  if (keys.length === 0) return null;
  const patch: Record<string, unknown> = {};
  for (const key of keys) {
    const value = payload[key];
    const valid =
      (key === 'locale' && isSettingsLocale(value)) ||
      (key === 'theme' && isThemeChoice(value)) ||
      (key === 'density' && isDensityChoice(value)) ||
      (key === 'editorFontSize' && isFontSize(value)) ||
      (BOOLEAN_KEYS.includes(key) && isBoolean(value)) ||
      (key === 'paletteRecents' && isPaletteRecents(value));
    if (!valid) return null;
    patch[key] = value;
  }
  return patch as SettingsPatch;
}

/** Why the settings file was not used as it was (shown once to the user). */
export type SettingsNotice = 'corrupt' | 'newer-version' | null;
