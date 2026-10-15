import type { MessageKey } from './zh-CN';
import { welcomeHistoryEn } from './welcome-history';
import { commandsEn } from './commands'; // S24
import { previewToolbarEn } from './preview-toolbar'; // S14/S15.4
import { aiChatEn } from './ai-chat'; // S33

/** English (required locale). Must define exactly the keys of zh-CN.ts. */
export const en: Record<MessageKey, string> = {
  'app.name': 'NoobIDE',
  'topbar.noProject': 'No project open',
  'topbar.sampleNotice': 'Editing a sample — nothing is saved to disk',
  'topbar.saveStatus': 'Save status',
  'topbar.saveStatus.noFile': 'No file open',
  'topbar.language': 'Interface language',
  'topbar.switchLanguage': '中文',
  'region.topbar': 'Top bar',
  'region.rail': 'Tool bar',
  'region.files': 'Files',
  'region.editor': 'Editor',
  'region.preview': 'Preview',
  'region.problems': 'Problems and console',
  'rail.files': 'Files',
  'rail.problems': 'Problems',
  'files.empty': 'No folder is open yet.',
  'editor.loading': 'Loading the editor…',
  'editor.welcomeTab': 'sample.html',
  'editor.sampleBadge': 'Sample · not saved to disk',
  'preview.stopped': 'Not running',
  'preview.placeholder': 'The webpage preview will appear here.',
  'preview.hint': 'Once a project is open, your page runs in its own isolated window.',
  // ── S04/S05 preview ──
  'preview.state.starting': 'Starting',
  'preview.state.running': 'Running',
  'preview.state.refreshing': 'Refreshing',
  'preview.state.unresponsive': 'Page not responding',
  'preview.state.failed': 'Failed',
  'preview.start': 'Start preview',
  'preview.stop': 'Stop',
  'preview.reload': 'Refresh',
  'preview.notUpdated': 'Preview not updated',
  'preview.notUpdatedDetail':
    'The save failed, so the preview still shows the last successfully saved version. It refreshes once a save succeeds.',
  'preview.startHint':
    'Click "Start preview" to run the page of this project. It runs in its own isolated window and cannot read other files on your computer.',
  'preview.unresponsiveDetail':
    'A script on the page may be stuck in an endless loop (for example while (true)). Click "Stop" to end it, fix the code, then start the preview again. The editor is not affected.',
  'preview.failed.server': 'The preview server could not start. Please try again.',
  'preview.failed.crashed': 'The page quit unexpectedly. Click "Start preview" to run it again.',
  'preview.console': 'Page console',
  'preview.console.empty': 'The page has not logged anything yet.',
  'preview.console.dropped': 'Too much output: {count} messages were left out.',
  'preview.console.droppedAtLeast':
    'Too much output: at least {count} messages were left out (some were not counted, to keep the editor smooth).',
  'preview.level.debug': 'Debug',
  'preview.level.info': 'Info',
  'preview.level.warning': 'Warning',
  'preview.level.error': 'Error',
  'problems.tab': 'Problems',
  'problems.unchecked': 'Not checked yet',
  'problems.uncheckedDetail': 'Your code has not been checked yet. Open a project and save to see problems here.',
  'problems.toggle': 'Show or hide the problems panel',
  'problems.collapse': 'Collapse the problems panel',
  'narrow.switch': 'Show code or preview',
  'narrow.code': 'Code',
  'narrow.preview': 'Preview',
  // ── S20.3 file roles (src/renderer/workbench/file-role.ts) ──
  'fileRole.structure': 'Page structure',
  'fileRole.structure.detail': 'What is on the page: headings, paragraphs, buttons and images.',
  'fileRole.style': 'Visual styling',
  'fileRole.style.detail': 'How the page looks: colours, sizes, spacing and layout.',
  'fileRole.behavior': 'Interactive behavior',
  'fileRole.behavior.detail': 'What the page does, for example what happens when a button is clicked.',
  'fileRole.image': 'Image',
  'fileRole.image.detail': 'A picture the page can show, for example with an <img> tag.',
  'fileRole.font': 'Font',
  'fileRole.font.detail': 'A typeface the stylesheet can use with @font-face.',
  'fileRole.data': 'Data',
  'fileRole.data.detail': 'Structured data that a script can read.',
  'fileRole.hintLabel': 'What this file is for',
  // ── end S20.3 ──
  'files.openFolder': 'Open folder…',
  'files.openOther': 'Open another folder',
  'files.listLabel': 'Project files',
  'files.truncated': 'Too many files: only the first 2000 are listed.',
  'files.openFailed': 'This folder could not be opened. Try another folder.',
  'editor.pickFile': 'Pick a file on the left to start editing.',
  'editor.error.unsupported':
    'This file is not UTF-8 text (it may be an image or use another encoding). NoobIDE does not open it so it cannot be damaged.',
  'editor.error.tooLarge': 'This file is larger than 5 MB; NoobIDE does not open files this large yet.',
  'editor.error.notFound': 'This file was not found. It may have been moved or deleted.',
  'editor.error.generic': 'This file could not be opened.',
  'save.clean': 'No changes',
  'save.dirty': 'Unsaved',
  'save.saving': 'Saving…',
  'save.failed': 'Save failed — your edits are kept',
  'save.shortcut': 'Save',
  'save.error.permission': 'No permission to write: the file or folder is read-only.',
  'save.error.busy': 'Another program is using the file.',
  'save.error.diskFull': 'The disk is full.',
  'save.error.notFound': 'The file was moved or deleted.',
  'save.error.generic': 'Writing the file failed.',
  // S25.3: the OS privacy protection blocked the folder (macOS Files and Folders, Windows Controlled folder access).
  'protected.mac':
    'macOS privacy protection is blocking NoobIDE from this folder (Desktop, Documents, Downloads, iCloud Drive or an external drive). Open System Settings › Privacy & Security › Files and Folders, turn on access for NoobIDE, then try again.',
  'protected.windows':
    'Windows Controlled folder access (ransomware protection) is probably blocking NoobIDE from changing files in this folder. Open Windows Security › Virus & threat protection › Ransomware protection › Allow an app through Controlled folder access, add NoobIDE, then try again. Or keep your projects in a folder outside Documents and Desktop.',
  'protected.other':
    "The system's privacy protection is blocking NoobIDE from this folder. Allow NoobIDE to access it in the system settings, then try again.",
  'save.kept': 'Your edits are still in the editor and nothing was lost. Fix the cause, then save again.',
  'error.detail': 'Details',
  'save.saved': 'Saved',
  'save.conflict': 'The file changed on disk — not saved automatically',
  'save.retry': 'Retry saving',
  'save.elsewhere': 'Save a copy elsewhere…',
  'save.copySaved': 'A copy was saved to:',
  'save.copyFailed': 'Saving the copy failed:',
  'save.closeDiscarding': 'Close the window without these unsaved edits',
  'tabs.label': 'Open files',
  'tabs.close': 'Close',
  'tab.state.dirty': 'Unsaved',
  'tab.state.saving': 'Saving',
  'tab.state.failed': 'Save failed',
  'tab.state.conflict': 'Conflict',
  'zoom.label': 'Code font size',
  'zoom.in': 'Larger code font',
  'zoom.out': 'Smaller code font',
  'zoom.reset': 'Default font size',
  'editor.line': 'Ln',
  'editor.column': 'Col',
  'editor.mixedEol.crlf':
    'This file mixes two kinds of line breaks (CRLF and LF). The editor shows all of them as CRLF, and saving writes CRLF throughout the file.',
  'editor.mixedEol.lf':
    'This file mixes two kinds of line breaks (CRLF and LF). The editor shows all of them as LF, and saving writes LF throughout the file.',
  'reveal.finder': 'Show in Finder',
  'reveal.explorer': 'Show in File Explorer',
  'reveal.fileManager': 'Show in file manager',
  // ── S07/S08: file tree, encodings and file operations ──
  'tree.loading': 'Reading files…',
  'tree.listFailed':
    'The files in this folder could not be read. Check that the folder still exists and that you may open it.',
  'tree.emptyFolder': '(empty folder)',
  'tree.truncated': 'This folder has too many files: only the first 5000 are listed.',
  'tree.link': 'Shortcut (link)',
  'tree.linkOutside': 'Link points outside the project; NoobIDE does not open it',
  'tree.linkBroken': 'Link points to something that does not exist',
  'tree.folderDenied': 'No permission to read this folder.',
  'tree.folderFailed': 'This folder could not be read.',
  'files.newFile': 'New file',
  'files.newFolder': 'New folder',
  'files.newFileName': 'Name of the new file',
  'files.newFolderName': 'Name of the new folder',
  'files.renameLabel': 'New name',
  'files.nameHint': 'Press Enter to confirm, Esc to cancel',
  'name.empty': 'Enter a name.',
  'name.dotName': '"." and ".." have a special meaning and cannot be used as names.',
  'name.invalidChar': 'Windows and macOS do not allow these characters in names:',
  'name.controlChar': 'Names cannot contain line breaks, tabs or other control characters.',
  'name.reservedWindows':
    'This is a reserved device name on Windows (like CON, NUL, COM1). Choose another one, even on a Mac, so the project also works on Windows.',
  'name.trailingDotOrSpace':
    'Names cannot end with a dot or a space: Windows silently removes them and the file names would no longer match.',
  'name.startsWithDot':
    'Names starting with a dot are hidden by the system and not served to the preview. Choose another name.',
  'name.tooLong': 'This name is too long (at most 255 bytes; a Chinese character counts as 3).',
  'op.exists': 'There is already a file or folder called "{name}". NoobIDE never overwrites it; choose another name.',
  'op.caseConflict':
    'There is already "{name}", which differs only in upper/lower case. Windows and macOS treat them as the same file; choose another name.',
  'op.intoItself': 'A folder cannot be moved into itself.',
  'op.notFound': 'It is no longer there; it may have been moved or deleted.',
  'op.permission': 'No permission: the file or folder is read-only or protected by the system.',
  'op.busy': 'Another program is using it. Close that program and try again.',
  'op.outside': 'This location is not inside the project folder.',
  'op.generic': 'The operation did not succeed.',
  'op.saveFirstFailed':
    'This file has unsaved changes and saving them failed, so nothing was changed. Your edits are still in the editor.',
  'trash.windows': 'Recycle Bin',
  'trash.mac': 'Trash',
  'trash.other': 'Trash',
  'delete.title': 'Move to {trash}?',
  'delete.question': 'Move "{name}" to the {trash}?',
  'delete.folderNote': 'All files inside the folder are moved too.',
  'delete.restoreHint': 'You can restore it from the {trash} if you need it.',
  'delete.confirm': 'Move to {trash}',
  'delete.cancel': 'Cancel',
  'delete.failed': 'It could not be moved to the {trash}; it is still in place and nothing was deleted.',
  'menu.label': 'File actions',
  'menu.open': 'Open',
  'menu.rename': 'Rename…',
  'menu.delete': 'Delete…',
  'editor.encodingGuessed': '(legacy encodings carry no marker: this is a best guess, so the text may look wrong).',
  'tree.unportable': 'Name not valid on Windows or macOS',
  'tree.unportableExplain':
    'The name "{name}" is not valid on Windows or macOS (for example it ends with a dot or a space, contains a colon or backslash, or is a reserved name like CON), so NoobIDE does not open it. Press F2 to give it a new name; then it works normally.',
  'op.interrupted':
    'The rename did not finish, but nothing is lost: the item is now called "{name}" in the same folder. Rename it again.',
  'editor.readOnlyEncoding':
    'This file is not UTF-8, so it is shown read-only and cannot be damaged by saving. File encoding:',
  // --- S12 crash recovery ---
  'recovery.title': 'Unsaved changes from last time were found',
  'recovery.intro':
    'NoobIDE did not close normally last time. These changes were not saved to your files yet, but they are kept safe in the app data. Compare them and restore them.',
  'recovery.files': '{n} file(s) with unsaved changes',
  'recovery.review': 'Open project and review',
  'recovery.later': 'Decide later',
  'recovery.restore': 'Restore into editor',
  'recovery.discard': 'Discard this copy',
  'recovery.compareTitle': 'Compared with the file on disk',
  'recovery.legend': '+ lines are added by the recovered copy, − lines on disk are replaced. Save after restoring.',
  'recovery.added': '{n} line(s) added',
  'recovery.removed': '{n} line(s) removed',
  'recovery.identical': 'The content is the same as the file on disk.',
  'recovery.tooLarge': 'Too many changes to show line by line.',
  'recovery.skipped': '… {n} unchanged line(s) …',
  'recovery.diskMissing':
    'The file on disk is gone or cannot be opened, so the copy cannot be restored into the editor. Its full text is shown below; you can select and copy it.',
  'recovery.openFailed': 'The project folder cannot be opened. It may have been moved or deleted.',
  'recovery.readFailed': 'This recovery copy is damaged and cannot be read.',
  'recovery.updatedAt': 'Last changed',
  'recovery.usage': 'Recovery data uses {used} (limit {limit})',
  'recovery.clearAll': 'Clear all recovery data',
  'recovery.clearConfirm': 'Clear now? These unsaved changes cannot be brought back',
  'recovery.cancel': 'Cancel',
  'recovery.journalFailed': 'The crash-recovery copy could not be written. Save your file soon.',
  'recovery.lineAdded': 'added',
  'recovery.lineRemoved': 'removed',
  'recovery.saveFirst':
    'The editor still has unsaved changes (perhaps a file restored just now). Save first, then restore the next file — or decide later.',
  'recovery.restoreFailed': 'This file could not be restored. The recovery copy is still kept.',
  'recovery.discardConfirm': 'Discard now? These changes cannot be brought back',
  'recovery.recoveredText': 'Content of the recovery copy',
  // --- end S12 ---
  // --- S11 external changes ---
  'save.deleted': 'File deleted on disk — the text is still in the editor',
  'tab.state.deleted': 'Deleted',
  'disk.reloaded':
    'This file was changed outside NoobIDE; the new version from disk is shown (Undo brings back the previous text).',
  'disk.dismiss': 'OK',
  'conflict.title': 'This file was changed outside NoobIDE while you have unsaved changes.',
  'conflict.explain':
    'So that neither version is lost, NoobIDE did not save automatically. Compare the two versions, then choose which one to keep.',
  'conflict.compare': 'Compare the versions',
  'conflict.hideCompare': 'Hide comparison',
  'conflict.keepMine': 'Keep my version (overwrite the file on disk)',
  'conflict.takeDisk': 'Use the version on disk',
  'conflict.loading': 'Reading the version on disk…',
  'conflict.undoHint': 'After "Use the version on disk", Undo still brings your changes back.',
  'conflict.diffLabel': 'Comparison: the version on disk on the left, your version on the right',
  'conflict.summary': 'Compared with the version on disk, your version adds {added} lines and removes {removed} lines.',
  'conflict.identical': 'Both versions have the same content (only line endings differ).',
  'deleted.title': 'This file was deleted or moved away on disk.',
  'deleted.explain':
    'Its text is still here in the editor, nothing is lost. You can save it again where it was, or save a copy elsewhere.',
  'deleted.resave': 'Save it again where it was',
  'deleted.resaveFailed': 'Saving it again did not work.',
  'deleted.close': 'Close without keeping the text',
  'deleted.closeConfirm': 'Close it? The file no longer exists on disk; the text will not be kept',
  // --- end S11 ---
  // --- S13 app data ---
  'settings.corrupt': 'The settings file is damaged and could not be read.',
  'settings.newer': 'The settings file comes from a newer NoobIDE.',
  'settings.readOnly':
    'The settings this version understands are used; the file is left unchanged for the newer version. Settings changed now are not saved after you quit.',
  'settings.reset': 'The original file was backed up; the default settings are used now.',
  'settings.backup': 'Backup:',
  'appMenu.label': 'More actions',
  'appMenu.openLogs': 'Open logs folder',
  'appMenu.closeProject': 'Close project',
  'layout.resizeFiles': 'Resize the files panel',
  'layout.resizeEditor': 'Resize code and preview',
  'session.restored': 'Reopened your last project. Location:',
  'transfer.title':
    'This project may run into problems on the other system (Windows / macOS). NoobIDE has not changed any file:',
  'transfer.caseConflict':
    'In "{folder}", {names} differ only in letter case: on Windows and macOS they become one file. Rename one of them.',
  'transfer.unicodeConflict':
    'In "{folder}", {names} look the same but are written with different Unicode forms: macOS treats them as one file. Rename one of them.',
  'transfer.decomposedName':
    'The name "{path}" uses decomposed Unicode characters (common for files copied from a Mac): a link typed on Windows may not find it. Typing the name again fixes it.',
  'transfer.unportableName': 'The name "{path}" cannot be used on Windows or macOS. {reason}',
  'transfer.mixedEol': '"{path}" mixes CRLF and LF line breaks: after you edit and save it, they become one kind.',
  'transfer.rootFolder': 'the project folder',
  'transfer.more': '{n} more not listed.',
  'transfer.truncated': 'The project is large; only part of it was checked.',
  'files.setEntry': 'Set as entry page',
  'entry.set': 'Entry page set:',
  'entry.setDetail':
    'The preview opens it first next time it starts. The setting is kept in the project’s .noobide/project.json; deleting that file does not affect the website.',
  'entry.failed': 'The entry page setting could not be saved.',
  'entry.invalidExisting':
    'The project’s .noobide/project.json could not be read (maybe from a newer version or edited by hand); it was left unchanged so nothing is overwritten.',
  // --- end S13 ---
  // S20.2 welcome + create wizard, S21.3/S21.4 local history (welcome-history.ts)
  ...welcomeHistoryEn,
  ...commandsEn, // S24
  ...previewToolbarEn, // S14/S15.4 preview manager and toolbar
  ...aiChatEn, // S33 AI chat and explain
  // --- S18.3 formatting ---
  'format.button': 'Format',
  'format.title': 'Format the code: indentation and line breaks ({shortcut})',
  // --- end S18.3 ---
  // --- S17.1 problems panel ---
  'problems.section.static': 'Code check',
  'problems.section.runtime': 'While the page runs',
  'problems.section.resource': 'Loading files',
  'problems.sectionEmpty': 'None',
  'problems.severity.error': 'Error',
  'problems.severity.warning': 'Warning',
  'problems.severity.info': 'Note',
  'problems.count.errors': '{n} errors',
  'problems.count.warnings': '{n} warnings',
  'problems.count.info': '{n} notes',
  'problems.none': 'No problems found',
  'problems.noneDetail': 'Nothing found in the open files or the running preview. Only open files are checked.',
  'problems.announce.new': '{n} new problems. See Problems for an explanation.',
  'problems.announce.cleared': 'All problems are solved.',
  'problems.stale': 'Not seen again after refresh',
  'problems.clearResolved': 'Clear resolved problems',
  // --- end S17.1 ---
  // --- S17.2 go to code and original error ---
  'problems.original.sourceStatic': 'Source: code check ({owner})',
  'problems.original.sourcePreview': 'Source: preview page (session {session}, load {generation})',
  'problems.original.sourcePage': 'Source: preview page',
  'problems.original.latest': 'Latest occurrence:',
  'problems.original.truncated': 'The original text was too long; only the beginning is kept.',
  'problems.original.code': 'Code',
  'problems.original.firstSeen': 'First',
  'problems.original.lastSeen': 'Latest',
  // --- S22.4 problem card / S22.5 one-click fix ---
  'problems.card.source.static': 'Code check',
  'problems.card.source.runtime': 'Runtime error',
  'problems.card.source.resource': 'Loading failed',
  'problems.card.source.console': 'Console error',
  'problems.card.count': '×{n} times',
  'problems.fix.heading': 'Your one-click fix',
  'problems.fix.applying': 'Changing {from} to {to} and saving…',
  'problems.fix.notApplied.changed':
    'Nothing was changed: line {line} of {file} has changed and no longer reads {from}.',
  'problems.fix.notApplied.readOnly': 'Nothing was changed: {file} is read-only.',
  'problems.fix.notApplied.notOpen': 'Nothing was changed: {file} could not be opened.',
  'problems.fix.saveFailed':
    'Changed {from} to {to} in the editor, but saving failed: {reason} The change is kept in the editor; the problem is not resolved yet.',
  'problems.fix.unchecked':
    'Changed {from} to {to} and saved, but could not check again (the code check did not answer, or the file was closed). So it cannot be called resolved yet; use Check again to retry.',
  'problems.fix.checking': 'Changed {from} to {to} and saved. Checking again…',
  'problems.fix.awaitingRefresh':
    'Changed {from} to {to} and saved; the code check no longer reports this problem. Waiting for the preview to refresh to confirm the page no longer reports it either.',
  'problems.fix.stillReported':
    'Changed {from} to {to}, but checking again still reports this problem. Look at the original error, or go to the code.',
  'problems.fix.resolved.static': 'Resolved: {file} line {line} — checking again no longer reports this problem.',
  'problems.fix.resolved.runtime':
    'Resolved: {file} line {line} — not reported again after checking again and refreshing the preview.',
  'problems.fix.undoing': 'Undoing…',
  'problems.fix.undone': 'Undone: {file} line {line} reads {from} again, and it is saved.',
  'problems.fix.undoFailed.changed':
    'Cannot undo: that part of the code has changed since. You can undo in the editor with {shortcut}.',
  'problems.fix.undoFailed.save': 'Undone, but saving failed: {reason} The text is kept in the editor.',
  'problems.fix.undoHint': 'You can also undo this change in the editor with {shortcut}.',
  'problems.fix.undo': 'Undo this change',
  'problems.fix.retrySave': 'Save again',
  'problems.fix.recheck': 'Check again',
  'problems.fix.clear': 'Clear',
  // --- end S22.4 / S22.5 ---
  // --- end S17.2 ---
  // --- S17.3 console view ---
  'preview.console.filter': 'Show',
  'preview.console.level.all': 'All',
  'preview.console.level.error': 'Errors only',
  'preview.console.level.warning': 'Warnings only',
  'preview.console.level.info': 'Info only',
  'preview.console.clear': 'Clear',
  'preview.console.cap': 'Keeps the latest {count} lines at most',
  'preview.console.onlyCurrent': 'Hide output from before the refresh ({count})',
  'preview.console.olderTag': 'Before refresh',
  'preview.console.emptyFiltered': 'No output matches the filter.',
  // --- end S17.3 ---
  // --- S25.4 preview permissions / decision 0016 flood stop ---
  'preview.notice.permissionDenied':
    'The page asked for {permission} access. The preview denies it by default, so features that need it (such as getUserMedia or geolocation) fail. To try them, use “Open in browser”.',
  'preview.notice.consoleFloodStopped':
    'The page wrote far too many console messages too quickly (getting around the output limit). To keep the editor responsive, NoobIDE stopped the script that was running. Check for a loop that keeps calling console.log.',
  'preview.permission.camera': 'camera',
  'preview.permission.microphone': 'microphone',
  'preview.permission.camera-microphone': 'camera and microphone',
  'preview.permission.location': 'location',
  'preview.permission.notifications': 'notification',
  'preview.permission.midi': 'MIDI device',
  'preview.permission.clipboard': 'clipboard',
  'preview.permission.screen': 'screen sharing',
  'preview.permission.devices': 'device (USB, HID, serial, Bluetooth)',
  'preview.permission.fullscreen': 'fullscreen',
  'preview.permission.other': 'other',
  'preview.notice.permissionDeniedOther':
    'The page asked for a browser permission (such as locking the mouse pointer or opening another app). The preview denies it by default. To try it, use “Open in browser”.',
  // --- end S25.4 ---
  // --- S28.1 About ---
  'about.title': 'About NoobIDE',
  'about.description':
    'A webpage editor for beginners: write HTML, CSS and JavaScript and preview the page next to it.',
  'about.version': 'Version {version}',
  'about.runtime': 'Electron {electron} · Chromium {chromium}',
  'about.close': 'Close',
  // --- end S28.1 ---
  // --- S23 onboarding walkthrough, final task and glossary ---
  'walkthrough.region': 'Walkthrough',
  'walkthrough.progress': 'Step {n} of {total}',
  'walkthrough.where': 'Where: ',
  'walkthrough.done': '✓ This step is done!',
  'walkthrough.waiting': 'Waiting for you to do this step… (or skip it)',
  'walkthrough.terms': 'Terms: ',
  'walkthrough.back': 'Back',
  'walkthrough.next': 'Next',
  'walkthrough.skipStep': 'Skip this step',
  'walkthrough.finish': 'Finish walkthrough',
  'walkthrough.showMe': 'Show me',
  'walkthrough.close': 'Close walkthrough',
  'walkthrough.closeHint': 'You can open it again from More actions → Help: walkthrough.',
  'walkthrough.offer.title': 'Walkthrough complete!',
  'walkthrough.offer.text': 'Want to check what you learned? Try a small task without hints.',
  'walkthrough.task.start': 'Start the task',
  'walkthrough.task.later': 'Not now',
  'walkthrough.task.waiting': 'Not done yet — this is checked automatically after each save.',
  'walkthrough.task.stop': 'Stop the task',
  'walkthrough.task.close': 'Close',
  'glossary.title': 'Glossary',
  'glossary.intro':
    'Standard terms you will meet in tutorials. The terms stay as they are, so you can search for them online.',
  'glossary.search': 'Search terms',
  'glossary.empty': 'No term matches.',
  'glossary.close': 'Close',
  // --- end S23 ---
  // --- S15.3 viewport width, S15.5/S15.6 keyboard focus into the page ---
  'preview.viewport.label': 'Page width',
  'preview.viewport.desktop': 'Desktop width',
  'preview.viewport.mobile': 'Mobile width {width}px',
  'preview.viewport.note':
    'Changes only the width of the page. This is not phone emulation: no mobile system, touch or pixel density.',
  'preview.stage.label': 'Web page preview. Press Enter to go into the page, F6 to come back to NoobIDE.',
  // --- end S15 ---
};
