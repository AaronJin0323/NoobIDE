import type { CommandHandlers } from '../commands/useCommands';

/**
 * S15.4: the preview toolbar's commands in the S24 command registry. The workbench registers these stable handlers
 * with its other commands (shortcut, native menu, in-window menu); they forward to whatever the mounted preview pane
 * registered, so the pane keeps its own state and the workbench needs no knowledge of the preview.
 */
export type PreviewCommandId =
  'preview-refresh' | 'preview-stop' | 'preview-open-external' | 'preview-devtools' | 'preview-clear-data';

export type PreviewCommandTarget = Partial<Record<PreviewCommandId, () => void>>;

let target: PreviewCommandTarget | null = null;

/** Called by the preview pane; returns the function that unregisters it. */
export function setPreviewCommandTarget(next: PreviewCommandTarget): () => void {
  target = next;
  return () => {
    if (target === next) target = null;
  };
}

const forward = (id: PreviewCommandId) => () => target?.[id]?.();

export const PREVIEW_COMMAND_HANDLERS: CommandHandlers = {
  'preview-refresh': forward('preview-refresh'),
  'preview-stop': forward('preview-stop'),
  'preview-open-external': forward('preview-open-external'),
  'preview-devtools': forward('preview-devtools'),
  'preview-clear-data': forward('preview-clear-data'),
};
