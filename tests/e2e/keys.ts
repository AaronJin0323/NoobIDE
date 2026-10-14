/**
 * Editor shortcuts whose keys differ by platform, as Monaco binds them: Ctrl+Home / Ctrl+End on Windows and Linux,
 * ⌘↑ / ⌘↓ on macOS (Monaco does not bind ⌘Home / ⌘End, so `ControlOrMeta+Home` would not move the cursor there).
 */
const isMac = process.platform === 'darwin';

/** Moves the cursor to the start of the document. */
export const DOC_START = isMac ? 'Meta+ArrowUp' : 'Control+Home';

/** Moves the cursor to the end of the document. */
export const DOC_END = isMac ? 'Meta+ArrowDown' : 'Control+End';

/** Opens find and replace: Ctrl+H, or ⌥⌘F on macOS (⌘H hides the app there). */
export const FIND_REPLACE = isMac ? 'Meta+Alt+F' : 'Control+H';
