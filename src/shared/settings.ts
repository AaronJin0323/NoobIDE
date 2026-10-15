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

export const EDITOR_FONT_SIZE = { min: 10, max: 32, default: 16 } as const;

export interface AppSettings {
  readonly version: typeof SETTINGS_VERSION;
  readonly locale: SettingsLocale;
  readonly theme: ThemeChoice;
  /** Code font size in px (PLAN §3: start at about 16px). */
  readonly editorFontSize: number;
  /** Reopen the last project, its tabs and the layout on a normal start (S13.4). */
  readonly restoreSession: boolean;
}

export const DEFAULT_SETTINGS: AppSettings = {
  version: SETTINGS_VERSION,
  locale: 'zh-CN',
  theme: 'system',
  editorFontSize: EDITOR_FONT_SIZE.default,
  restoreSession: true,
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
    editorFontSize: pick('editorFontSize', isFontSize),
    restoreSession: pick('restoreSession', (v) => typeof v === 'boolean'),
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
      (key === 'editorFontSize' && isFontSize(value)) ||
      (key === 'restoreSession' && typeof value === 'boolean');
    if (!valid) return null;
    patch[key] = value;
  }
  return patch as SettingsPatch;
}

/** Why the settings file was not used as it was (shown once to the user). */
export type SettingsNotice = 'corrupt' | 'newer-version' | null;
