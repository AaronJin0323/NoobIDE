import { useCallback, useEffect, useId, useState } from 'react';
import { AI_PROVIDERS } from '../../shared/ipc/ai-contract';
import type { AiHistoryApi, AiUsageSummary } from '../../shared/ipc/ai-history-contract';
import { AI_HISTORY_LIMITS } from '../../shared/ipc/ai-history-parse';
import type { MessageKey } from '../i18n/index';
import { fill } from '../recovery/format';
import { notifyAiStatusChanged, PROVIDER_LABEL } from './ai-status';
import './ai-history.css';

/** `count` picks the singular form of a counted message (i18n/plural.ts). */
type Translate = (key: MessageKey, count?: number) => string;

export const DEFAULT_DAILY_BUDGET = 200_000;

/** Parses the budget field: a whole number in range, or null. Spaces and thousands separators are ignored. */
export function parseBudgetInput(text: string): number | null {
  const digits = text.replace(/[\s,.'’_]/g, '');
  if (!/^\d{1,10}$/.test(digits)) return null;
  const value = Number(digits);
  return value >= AI_HISTORY_LIMITS.minBudget && value <= AI_HISTORY_LIMITS.maxBudget ? value : null;
}

/** The usage lines of Settings → AI as text (unit-tested in both locales). */
export function usageLines(t: Translate, usage: AiUsageSummary, locale: string): string[] {
  const n = (value: number) => value.toLocaleString(locale);
  return [
    ...AI_PROVIDERS.map((p) =>
      fill(t('ai.usage.provider'), {
        provider: t(PROVIDER_LABEL[p]),
        input: n(usage.perProvider[p].inputTokens),
        output: n(usage.perProvider[p].outputTokens),
      }),
    ),
    fill(t('ai.usage.total'), { total: n(usage.totalTokens) }),
  ];
}

export function budgetStateText(t: Translate, usage: AiUsageSummary, locale: string): string {
  if (usage.dailyBudget === null) return t('ai.usage.budget.off');
  if (usage.budgetReached) return t('ai.usage.budget.reached');
  return fill(t('ai.usage.budget.state'), {
    used: usage.totalTokens.toLocaleString(locale),
    budget: usage.dailyBudget.toLocaleString(locale),
  });
}

/**
 * Settings → AI, "Token use today" (S39.2): today's input/output tokens per provider (kept in app data by main) and
 * the optional daily budget (off by default). Every state is said in words; the controls are plain form fields.
 */
export function AiUsageSection({
  api,
  t,
  locale,
}: {
  readonly api: AiHistoryApi;
  readonly t: Translate;
  readonly locale: string;
}) {
  const amountId = useId();
  const [usage, setUsage] = useState<AiUsageSummary | null>(null);
  const [limitOn, setLimitOn] = useState(false);
  const [draft, setDraft] = useState(String(DEFAULT_DAILY_BUDGET));
  const [message, setMessage] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);

  const apply = useCallback((summary: AiUsageSummary) => {
    setUsage(summary);
    setLimitOn(summary.dailyBudget !== null);
    if (summary.dailyBudget !== null) setDraft(String(summary.dailyBudget));
  }, []);

  useEffect(() => {
    void api.usage().then(
      (result) => result.ok && apply(result.value),
      () => undefined,
    );
  }, [api, apply]);

  const save = async (dailyTokens: number | null) => {
    const result = await api.setDailyBudget({ dailyTokens });
    if (result.ok) {
      apply(result.value);
      setMessage(dailyTokens === null ? null : { tone: 'ok', text: t('ai.usage.budget.saved') });
      notifyAiStatusChanged(); // inline suggestions pause or resume at once
    }
  };

  const invalid = fill(t('ai.usage.budget.invalid'), {
    min: AI_HISTORY_LIMITS.minBudget.toLocaleString(locale),
    max: AI_HISTORY_LIMITS.maxBudget.toLocaleString(locale),
  });

  return (
    <div className="ais-section" data-testid="ai-usage-section">
      <h3 className="ais-label">{t('ai.usage.title')}</h3>
      {usage && (
        <ul className="ai-usage-lines" data-testid="ai-usage-today">
          {usageLines(t, usage, locale).map((text) => (
            <li key={text}>{text}</li>
          ))}
        </ul>
      )}
      <p className="dialog-hint">{t('ai.usage.note')}</p>
      <label className="ais-check">
        <input
          type="checkbox"
          checked={limitOn}
          data-testid="ai-budget-enabled"
          onChange={(event) => {
            setMessage(null);
            setLimitOn(event.target.checked);
            if (!event.target.checked) void save(null);
          }}
        />
        <span>{t('ai.usage.budget')}</span>
      </label>
      {limitOn && (
        <form
          className="ais-row"
          onSubmit={(event) => {
            event.preventDefault();
            const value = parseBudgetInput(draft);
            if (value === null) setMessage({ tone: 'error', text: invalid });
            else void save(value);
          }}
        >
          <label className="ais-label" htmlFor={amountId}>
            {t('ai.usage.budget.amount')}
          </label>
          <input
            id={amountId}
            className="ais-input"
            inputMode="numeric"
            value={draft}
            data-testid="ai-budget-amount"
            onChange={(event) => setDraft(event.target.value)}
          />
          <button type="submit" className="secondary-button" data-testid="ai-budget-save">
            {t('ai.usage.budget.save')}
          </button>
        </form>
      )}
      {usage && (
        <p
          className="dialog-hint"
          role="status"
          data-testid="ai-budget-state"
          data-reached={usage.budgetReached ? 'true' : 'false'}
        >
          {budgetStateText(t, usage, locale)}
        </p>
      )}
      {message && (
        <p
          className={`ais-message ai-message-${message.tone}`}
          role={message.tone === 'error' ? 'alert' : 'status'}
          data-testid="ai-budget-message"
        >
          {message.text}
        </p>
      )}
    </div>
  );
}

/**
 * After the project's AI consent was revoked (S39.1): offers to delete its saved chats too, when it has any.
 */
export function RevokeChatsPrompt({
  api,
  projectId,
  count,
  onDone,
  t,
}: {
  readonly api: AiHistoryApi;
  readonly projectId: string;
  readonly count: number;
  readonly onDone: (deleted: number | null) => void;
  readonly t: Translate;
}) {
  return (
    <div className="ais-section" role="group" aria-label={t('ai.history.title')} data-testid="ai-revoke-chats">
      <p>{fill(t('ai.history.revoke.ask', count), { n: count })}</p>
      <div className="ais-row">
        <button
          type="button"
          className="secondary-button"
          data-testid="ai-revoke-chats-delete"
          onClick={() =>
            void api.deleteProjectChats({ projectId }).then(
              (result) => onDone(result.ok ? result.value.deleted : 0),
              () => onDone(0),
            )
          }
        >
          {t('ai.history.revoke.delete')}
        </button>
        <button type="button" className="quiet-button" data-testid="ai-revoke-chats-keep" onClick={() => onDone(null)}>
          {t('ai.history.revoke.keep')}
        </button>
      </div>
    </div>
  );
}
