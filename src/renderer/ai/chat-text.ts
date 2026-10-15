/**
 * Text of the chat panel that depends on data: chip labels, error explanations, the provider's name. Pure, so both
 * locales are unit-tested for every AiErrorCode.
 */
import type { AiContextItem, AiErrorCode, AiProviderId } from '../../shared/ipc/ai-contract';
import type { MessageKey } from '../i18n/index';
import { fill } from '../recovery/format';

type Translate = (key: MessageKey) => string;

export const AI_ERROR_CODES: readonly AiErrorCode[] = [
  'disabled',
  'no-key',
  'no-consent',
  'unauthorized',
  'rate-limited',
  'offline',
  'context-too-large',
  'refused',
  'cancelled',
  'provider-error',
  'unknown-project',
  'budget-exhausted',
  'budget-reached',
  'preview-expired',
];

const ERROR_KEYS: Record<AiErrorCode, MessageKey> = {
  disabled: 'ai.error.disabled',
  'no-key': 'ai.error.no-key',
  'no-consent': 'ai.error.no-consent',
  unauthorized: 'ai.error.unauthorized',
  'rate-limited': 'ai.error.rate-limited',
  offline: 'ai.error.offline',
  'context-too-large': 'ai.error.context-too-large',
  refused: 'ai.error.refused',
  cancelled: 'ai.error.cancelled',
  'provider-error': 'ai.error.provider-error',
  'unknown-project': 'ai.error.unknown-project',
  'budget-exhausted': 'ai.error.budget-exhausted', // S34
  'budget-reached': 'ai.error.budget-reached', // S39.2
  'preview-expired': 'ai.error.preview-expired', // S38.2
};

/** The plain-language explanation of an error code; IPC errors ('invalid-request', …) get the generic text. */
export function errorExplanation(t: Translate, code: string): string {
  const key = (ERROR_KEYS as Record<string, MessageKey | undefined>)[code];
  return t(key ?? 'ai.error.generic');
}

export function providerName(t: Translate, provider: AiProviderId | null): string {
  if (provider === 'anthropic') return t('ai.provider.anthropic');
  if (provider === 'openai') return t('ai.provider.openai');
  return t('ai.provider.unknown');
}

/** The label of a context item, as shown on its chip and in "Sent with". */
export function contextLabel(t: Translate, item: AiContextItem): string {
  const path = item.relPath ?? '';
  switch (item.kind) {
    case 'file':
      return fill(t('ai.chat.context.file'), { path });
    case 'selection':
      if (item.startLine !== undefined && item.endLine !== undefined && item.endLine !== item.startLine) {
        return fill(t('ai.chat.context.selection'), { path, start: item.startLine, end: item.endLine });
      }
      return fill(t('ai.chat.context.selectionLine'), { path, start: item.startLine ?? 1 });
    case 'problem':
      return path && item.startLine
        ? fill(t('ai.chat.context.problemAt'), { label: item.label ?? '', path, line: item.startLine })
        : fill(t('ai.chat.context.problem'), { label: item.label ?? '' });
    case 'console':
      return item.label ?? t('ai.chat.context.console');
    case 'preview':
      return item.label
        ? fill(t('ai.chat.context.preview'), { path: item.label })
        : t('ai.chat.context.previewStartPage');
  }
}
