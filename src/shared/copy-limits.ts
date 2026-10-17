/**
 * S52.2/S52.4: the most one copy, paste, duplicate or import may create (counted before anything is written). Shared
 * so main enforces it and the renderer's explanations name the same numbers.
 */
export const COPY_LIMITS = { maxEntries: 10_000, maxBytes: 2 * 1024 * 1024 * 1024 } as const;
