/**
 * "File saved" notifications for the preview (S10.5, PLAN §7: … confirm success → update status → trigger preview).
 * The workbench emits one only from a DocumentSaver's onSaved, i.e. strictly after main confirmed the write (temp
 * file renamed over the target) and after the tab's status was updated. A failed write never emits, so the preview
 * never claims to show content that is not on disk. The preview (S04) subscribes to refresh.
 */
export interface SavedFile {
  readonly relPath: string;
  readonly uri: string;
  /** Editor revision that is now on disk. */
  readonly revision: number;
}

export interface SavedFileEvents {
  subscribe(listener: (file: SavedFile) => void): () => void;
  emit(file: SavedFile): void;
}

export function createSavedFileEvents(): SavedFileEvents {
  const listeners = new Set<(file: SavedFile) => void>();
  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    emit(file) {
      for (const listener of [...listeners]) {
        try {
          listener(file);
        } catch {
          // A failing subscriber (e.g. a preview that is shutting down) must not undo or hide the save.
        }
      }
    },
  };
}
