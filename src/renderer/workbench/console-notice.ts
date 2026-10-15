import type { MessageKey } from '../i18n/index';
import type { PreviewNotice } from '../../shared/ipc/preview-contract';

/** What the console shows for an IDE notice: the explanation, and optionally the raw detail in smaller print. */
export interface NoticeText {
  readonly text: string;
  readonly detail?: string;
}

type Translate = (key: MessageKey) => string;

/**
 * Chromium net error codes (net/base/net_error_list.h) a beginner can meet when the preview page does not load,
 * grouped by what the user can do about them. Anything else gets the general explanation.
 */
const LOAD_FAILED_KEY: ReadonlyMap<number, MessageKey> = new Map<number, MessageKey>([
  [-6, 'preview.notice.loadFailed.notFound'], // ERR_FILE_NOT_FOUND
  [-7, 'preview.notice.loadFailed.timeout'], // ERR_TIMED_OUT
  [-118, 'preview.notice.loadFailed.timeout'], // ERR_CONNECTION_TIMED_OUT
  [-100, 'preview.notice.loadFailed.server'], // ERR_CONNECTION_CLOSED
  [-101, 'preview.notice.loadFailed.server'], // ERR_CONNECTION_RESET
  [-102, 'preview.notice.loadFailed.server'], // ERR_CONNECTION_REFUSED
  [-109, 'preview.notice.loadFailed.server'], // ERR_ADDRESS_UNREACHABLE
  [-324, 'preview.notice.loadFailed.server'], // ERR_EMPTY_RESPONSE
  [-105, 'preview.notice.loadFailed.offline'], // ERR_NAME_NOT_RESOLVED
  [-106, 'preview.notice.loadFailed.offline'], // ERR_INTERNET_DISCONNECTED
  [-10, 'preview.notice.loadFailed.blocked'], // ERR_ACCESS_DENIED
  [-20, 'preview.notice.loadFailed.blocked'], // ERR_BLOCKED_BY_CLIENT
  [-27, 'preview.notice.loadFailed.blocked'], // ERR_BLOCKED_BY_RESPONSE
]);

export function loadFailedKey(code: number): MessageKey {
  return LOAD_FAILED_KEY.get(code) ?? 'preview.notice.loadFailed.other';
}

/**
 * IDE notices about the page (S25.4 permissions, decision 0016 flood stop, blocked links, failed loads), in the
 * user's language. `message` is the record's English fallback; for a failed load it is Chromium's own description
 * (ERR_CONNECTION_REFUSED…), kept as secondary detail for searching the web or asking for help.
 */
export function noticeText(notice: PreviewNotice, message: string, t: Translate): NoticeText {
  switch (notice.kind) {
    case 'console-flood-stopped':
      return { text: t('preview.notice.consoleFloodStopped') };
    case 'restarted-after-sleep':
      return {
        text: t(
          notice.reason === 'server'
            ? 'preview.notice.restartedAfterSleepServer'
            : 'preview.notice.restartedAfterSleepPage',
        ),
      };
    case 'link-blocked':
      return {
        text: t(
          notice.how === 'new-window' ? 'preview.notice.linkBlockedNewWindow' : 'preview.notice.linkBlockedNavigate',
        ).replace('{button}', t('preview.openExternal')),
      };
    case 'load-failed': {
      const detail = message.trim();
      return { text: t(loadFailedKey(notice.code)), ...(detail ? { detail } : {}) };
    }
    case 'permission-denied':
      if (notice.permission === 'other') return { text: t('preview.notice.permissionDeniedOther') };
      return {
        text: t('preview.notice.permissionDenied').replace(
          '{permission}',
          t(`preview.permission.${notice.permission}`),
        ),
      };
  }
}
