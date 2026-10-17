import { StatusDot } from '../theme/StatusDot';
import { DotIcon, StopIcon, WarningIcon } from './icons';

/**
 * The icon in front of the preview state pill's word: a warning, the stop square, the breathing 6 px status dot while
 * the page runs (S47.4), or the plain ring for the states in between.
 */
export function PreviewStateIcon({ state, warning }: { readonly state: string; readonly warning: boolean }) {
  if (warning) return <WarningIcon />;
  if (state === 'stopped') return <StopIcon />;
  if (state === 'running') return <StatusDot pulse />;
  return <DotIcon />;
}
