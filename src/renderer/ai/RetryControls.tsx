import { useEffect, useState } from 'react';
import type { MessageKey } from '../i18n/index';
import { fill } from '../recovery/format';
import { BACKOFF, busyCause, countdownParts } from './backoff';
import type { ChatTurn } from './chat-model';
import { ReaskIcon } from './ai-icons';

type Translate = (key: MessageKey, count?: number) => string;

/** "1 分钟 20 秒" / "1 minute 20 seconds": the wait in words, never a bare number. */
export function waitInWords(remainingMs: number, t: Translate): string {
  const { minutes, seconds } = countdownParts(remainingMs);
  const parts: string[] = [];
  if (minutes > 0) parts.push(fill(t('ai.backoff.minutes', minutes), { n: minutes }));
  if (seconds > 0 || minutes === 0) parts.push(fill(t('ai.backoff.seconds', seconds), { n: seconds }));
  return parts.join(' ');
}

/** S48.7: why the provider made us wait (429 / 503), as a sentence, or null for other failures. */
export function causeText(turn: ChatTurn, t: Translate): string | null {
  const cause = turn.error ? busyCause(turn.error) : null;
  return cause === null ? null : t(cause === 503 ? 'ai.backoff.cause503' : 'ai.backoff.cause429');
}

/** Re-renders every second while a countdown runs. */
function useNow(running: boolean, now: () => number): number {
  const [time, setTime] = useState(now);
  useEffect(() => {
    if (!running) return undefined;
    setTime(now());
    const timer = setInterval(() => setTime(now()), 1000);
    return () => clearInterval(timer);
  }, [running, now]);
  return time;
}

/**
 * S48.7: Retry for a failed question. While an automatic retry after a 429 / 503 waits, the wait is shown in words
 * (a timer, so screen readers are not interrupted every second) with Retry now; after three automatic retries only
 * Retry is left, and the sentence says so.
 */
export function RetryControls({
  turn,
  onRetry,
  t,
  now = Date.now,
}: {
  readonly turn: ChatTurn;
  readonly onRetry: () => void;
  readonly t: Translate;
  readonly now?: () => number;
}) {
  const dueAt = turn.retry?.dueAt ?? null;
  const time = useNow(dueAt !== null, now);
  const automatic = turn.retry?.automatic ?? 0;
  const exhausted = dueAt === null && turn.retry?.cause != null && automatic >= BACKOFF.maxAutomatic;
  return (
    <div className="ai-retry" data-testid="ai-retry" data-waiting={dueAt !== null} data-exhausted={exhausted}>
      {dueAt !== null ? (
        <p className="ai-retry-wait" role="timer" aria-live="off" data-testid="ai-retry-countdown">
          {fill(t('ai.backoff.waiting'), {
            time: waitInWords(dueAt - time, t),
            attempt: automatic + 1,
            max: BACKOFF.maxAutomatic,
          })}
        </p>
      ) : (
        <p className="ai-hint" data-testid="ai-retry-note">
          {exhausted ? fill(t('ai.backoff.exhausted'), { max: BACKOFF.maxAutomatic }) : t('ai.retry.kept')}
        </p>
      )}
      <button
        type="button"
        className="secondary-button ai-retry-button"
        data-testid="ai-retry-button"
        onClick={onRetry}
      >
        <ReaskIcon />
        {t(dueAt !== null ? 'ai.retry.now' : 'ai.retry.button')}
      </button>
    </div>
  );
}
