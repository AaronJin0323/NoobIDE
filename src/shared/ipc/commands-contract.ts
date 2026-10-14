/**
 * Typed contract between the workbench's command registry and main's native menus (S24.2). The renderer reports the
 * state `when` clauses read (validated with parseCommandContext) so main can enable menu items; main asks the
 * renderer to run a command by id when a native menu item is chosen. No other data crosses.
 */
import type { CommandContext, CommandId } from '../commands';
import type { IpcResult } from './contract';

export const COMMAND_CHANNELS = {
  setContext: 'app:set-command-context',
} as const;

export const COMMAND_EVENTS = {
  /** main → renderer: run this command (payload: a CommandId). */
  run: 'app:run-command',
} as const;

export interface CommandsApi {
  setContext(context: CommandContext): Promise<IpcResult<null, never>>;
  /** Native menu choices. The listener only ever receives a known command id. Returns the unsubscribe function. */
  onRun(listener: (id: CommandId) => void): () => void;
}
