import { useCallback, useEffect, useRef, useState } from 'react';
import type { SettingsApi } from '../../shared/ipc/app-data-contract';
import { recordRecent } from './palette-model';

/**
 * S49.5: the commands last run from the palette, newest first. Read from the app settings (app data, per user) on
 * start and written back after every run; a run before the stored list arrived is merged into it, never lost.
 */
export function usePaletteRecents(settings: Pick<SettingsApi, 'get' | 'update'> | undefined): {
  readonly recents: readonly string[];
  readonly record: (id: string) => void;
} {
  const [recents, setRecents] = useState<readonly string[]>([]);
  const early = useRef<string[]>([]);
  const loaded = useRef(false);
  useEffect(() => {
    let cancelled = false;
    void settings?.get().then((result) => {
      if (cancelled || !result.ok) return;
      loaded.current = true;
      let list: readonly string[] = result.value.settings.paletteRecents ?? [];
      for (const id of early.current) list = recordRecent(list, id);
      if (early.current.length > 0) void settings.update({ paletteRecents: [...list] });
      early.current = [];
      setRecents(list);
    });
    return () => {
      cancelled = true;
    };
  }, [settings]);
  const record = useCallback(
    (id: string) => {
      if (!loaded.current) early.current.push(id);
      setRecents((list) => {
        const next = recordRecent(list, id);
        if (loaded.current) void settings?.update({ paletteRecents: next });
        return next;
      });
    },
    [settings],
  );
  return { recents, record };
}
