import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { aiStatusCache } from './inline-status';

const subscribe = (listener: () => void) => aiStatusCache.subscribe(listener);

/**
 * S32.1: whether AI ghost-text suggestions are on for the open project, as text for the editor's status line
 * ('on' / 'off'), or null when AI is not usable here at all (no bridge, AI off, no key) — then nothing is shown.
 */
export function useInlineAiState(projectId: string | null): 'on' | 'off' | null {
  useEffect(() => {
    if (projectId !== null) void aiStatusCache.get(projectId);
  }, [projectId]);
  const read = useCallback((): 'on' | 'off' | null => {
    if (projectId === null) return null;
    const status = aiStatusCache.peek(projectId);
    if (!status || !status.config.enabled) return null;
    const { provider } = status.config;
    if (provider === null || !status.keyStored[provider]) return null;
    return status.config.inlineCompletions ? 'on' : 'off';
  }, [projectId]);
  return useSyncExternalStore(subscribe, read);
}

/** S32.1 command: switches the suggestions on or off; the status line shows the result. */
export function toggleInlineAi(projectId: string | null): void {
  void aiStatusCache.toggleInline(projectId);
}
