import type { MessageKey } from './zh-CN';

/**
 * Singular forms for messages with a count (`{n}`). The dictionaries hold the plural ("3 errors"); a locale that
 * distinguishes one (English) lists the `n === 1` form here, and `translate(locale, key, n)` picks it. zh-CN has no
 * grammatical plural, so it needs none. Keep each entry identical to its dictionary text except for the number.
 */
export const ONE_FORMS: Partial<Record<'zh-CN' | 'en', Partial<Record<MessageKey, string>>>> = {
  en: {
    'checkpoints.saved': 'Checkpoint “{name}” saved ({files} file).',
    'checkpoints.unchanged': '{n} other file is unchanged.',
    'checkpoints.restore.summary': '{n} file will be written back.',
    'checkpoints.restore.done': '{n} file restored.',
    'checkpoints.restore.trashed': '{n} added file moved to the system trash.',
    'checkpoints.restore.skipped': '{n} file was not restored:',
    'checkpoints.damaged':
      '{n} checkpoint cannot be used (damaged, unreadable just now, or from a newer NoobIDE). You can delete it.',
    'problems.count.errors': '{n} error',
    'problems.count.warnings': '{n} warning',
    'problems.count.info': '{n} note',
    'problems.announce.new': '{n} new problem. See Problems for an explanation.',
    'recovery.files': '{n} file with unsaved changes',
    'recovery.added': '{n} line added',
    'recovery.removed': '{n} line removed',
    'recovery.skipped': '… {n} unchanged line …',
    'history.group.undoPartial': '{n} change undone; {m} not undone: {reasons}',
    'agent.diff.added': '{n} line added',
    'agent.diff.removed': '{n} line removed',
    'agent.undo.done': 'Undid {n} change.',
    'agent.undo.partial': '{n} change undone; {m} could not be undone: {reasons}',
    'ai.chat.proposal.unsupported':
      'The AI wants to change {n} file, but this version cannot show the changes here. No file was changed.',
    'ai.chat.jumpPending': '{n} new message',
    'ai.backoff.minutes': '{n} minute', // S48.7
    'ai.backoff.seconds': '{n} second',
    'ai.history.skipped': '{n} saved chat could not be read (damaged, or saved by a newer NoobIDE) and was skipped.',
    'ai.history.revoke.ask': 'This project also has {n} saved AI chat. Delete it too?',
    'ai.history.revoke.deleted': '{n} chat deleted.',
    'welcome.recentChats.ask':
      '“{name}” also has {n} saved AI chat in NoobIDE’s data folder. Delete it when removing the project from the list?',
  },
};
