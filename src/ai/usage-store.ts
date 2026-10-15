import type { RecoveryLogger } from '../recovery/atomic-file';
import { AI_PROVIDERS, type AiProviderId } from '../shared/ipc/ai-contract';
import type { AiUsageSummary, AiUsageTotals } from '../shared/ipc/ai-history-contract';
import { isDailyBudget } from '../shared/ipc/ai-history-parse';
import { VersionedJsonStore } from './config-store';

/**
 * Token usage per day and provider, and the optional daily budget (S39.2, decision 0025), in `ai-usage.json` in app
 * data. Token counts only — never prompts, code or answers. Days are local calendar days (`YYYY-MM-DD`), so "today"
 * starts again at local midnight; the last {@link USAGE_DAYS_KEPT} days are kept.
 *
 * The budget (off by default) counts input + output tokens of all providers today. `budgetReached()` is asked by the
 * request service before a NEW request starts; running requests finish and their tokens still count.
 */
export const AI_USAGE_VERSION = 1;
export const USAGE_DAYS_KEPT = 62;

type DayTotals = Readonly<Record<AiProviderId, AiUsageTotals>>;

interface UsageFile {
  readonly version: typeof AI_USAGE_VERSION;
  readonly dailyBudget: number | null;
  readonly days: Readonly<Record<string, DayTotals>>;
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const ZERO: AiUsageTotals = { inputTokens: 0, outputTokens: 0 };
const EMPTY_DAY: DayTotals = { anthropic: ZERO, openai: ZERO };
const EMPTY_FILE: UsageFile = { version: AI_USAGE_VERSION, dailyBudget: null, days: {} };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const tokens = (v: unknown): number => (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : 0);

/** Local calendar day of a time, `YYYY-MM-DD`. */
export function dayKey(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function parseTotals(raw: unknown): AiUsageTotals {
  return isRecord(raw) ? { inputTokens: tokens(raw.inputTokens), outputTokens: tokens(raw.outputTokens) } : ZERO;
}

function keepRecent(days: Record<string, DayTotals>): Record<string, DayTotals> {
  const keys = Object.keys(days).sort().slice(-USAGE_DAYS_KEPT);
  return Object.fromEntries(keys.map((k) => [k, days[k] as DayTotals]));
}

export function loadUsageFile(raw: unknown): UsageFile {
  if (!isRecord(raw)) return EMPTY_FILE;
  const days: Record<string, DayTotals> = {};
  if (isRecord(raw.days)) {
    for (const [key, value] of Object.entries(raw.days)) {
      if (!DAY.test(key) || !isRecord(value)) continue;
      days[key] = { anthropic: parseTotals(value.anthropic), openai: parseTotals(value.openai) };
    }
  }
  return {
    version: AI_USAGE_VERSION,
    dailyBudget: isDailyBudget(raw.dailyBudget) ? raw.dailyBudget : null,
    days: keepRecent(days),
  };
}

const sum = (day: DayTotals) => AI_PROVIDERS.reduce((total, p) => total + day[p].inputTokens + day[p].outputTokens, 0);

export class AiUsageStore extends VersionedJsonStore<UsageFile> {
  private readonly now: () => number;

  constructor(options: { readonly file: string; readonly log?: RecoveryLogger; readonly now?: () => number }) {
    super(options, 'ai-usage', AI_USAGE_VERSION, EMPTY_FILE, loadUsageFile);
    this.now = options.now ?? Date.now;
  }

  /** Adds one model call's tokens to today's total of the provider. */
  async record(provider: AiProviderId, usage: AiUsageTotals): Promise<void> {
    const input = tokens(usage.inputTokens);
    const output = tokens(usage.outputTokens);
    if (input === 0 && output === 0) return;
    const today = dayKey(this.now());
    await this.change((state) => {
      const day = state.days[today] ?? EMPTY_DAY;
      const next: DayTotals = {
        ...day,
        [provider]: {
          inputTokens: day[provider].inputTokens + input,
          outputTokens: day[provider].outputTokens + output,
        },
      };
      return { ...state, days: keepRecent({ ...state.days, [today]: next }) };
    });
  }

  async summary(): Promise<AiUsageSummary> {
    return this.summarize(await this.read());
  }

  async budgetReached(): Promise<boolean> {
    return (await this.summary()).budgetReached;
  }

  /** null switches the budget off. Values are checked by the IPC parser (isDailyBudget). */
  async setBudget(dailyTokens: number | null): Promise<AiUsageSummary> {
    const value = dailyTokens === null || isDailyBudget(dailyTokens) ? dailyTokens : null;
    return this.summarize(
      await this.change((state) => (state.dailyBudget === value ? state : { ...state, dailyBudget: value })),
    );
  }

  private summarize(state: UsageFile): AiUsageSummary {
    const day = dayKey(this.now());
    const totals = state.days[day] ?? EMPTY_DAY;
    const totalTokens = sum(totals);
    return {
      day,
      perProvider: totals,
      totalTokens,
      dailyBudget: state.dailyBudget,
      budgetReached: state.dailyBudget !== null && totalTokens >= state.dailyBudget,
    };
  }
}
