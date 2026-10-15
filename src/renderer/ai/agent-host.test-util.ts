import type { GroupRecordRequest, HistoryGroup, HistoryGroupStep } from '../../shared/ipc/history-contract';
import type { FilesChange } from '../workbench/FilesPanel';
import type { AgentApplyHost } from './agent-apply';

/**
 * In-memory stand-in for the workbench side of the agent (S34.2 tests): project files with content hashes, open
 * tabs, the OS trash, and a local history that behaves like main's for change groups (`groupBefore` keeps the
 * current content as a version, `groupRecord` stores the step with the hash now on disk, `groups` lists them newest
 * first). Every call is logged in order.
 */
export interface FakeFile {
  text: string;
  hash: string;
  bom?: boolean;
}

export interface FakeTab {
  text: string;
  readOnly?: boolean;
  blocked?: boolean;
  dirty?: boolean;
}

export function fakeAgentHost(files: Record<string, FakeFile>, open: Record<string, FakeTab> = {}) {
  const log: string[] = [];
  const trash: Record<string, FakeFile> = {};
  const folders = new Set<string>(['']);
  /** Kept versions by id: what the fake history can give back. */
  const versions = new Map<string, { relPath: string; text: string }>();
  const groups = new Map<string, { label: string; steps: HistoryGroupStep[]; undoneAt: number | null; seq: number }>();
  let hashes = 0;
  let seq = 0;
  const nextHash = () => `h${(hashes += 1)}`;
  const keep = (relPath: string, text: string) => {
    const id = `${1000 + versions.size}-abcdefabcdef-${versions.size + 1}`;
    versions.set(id, { relPath, text });
    return id;
  };
  const host: AgentApplyHost = {
    projectId: 'p',
    workspace: {
      async readFile({ relPath }) {
        const f = files[relPath];
        if (!f) return { ok: false, code: 'not-found', message: '' };
        return {
          ok: true,
          value: {
            text: f.text,
            eol: '\n',
            bom: f.bom ?? false,
            uri: `file:///${relPath}`,
            mixedEol: false,
            version: { mtimeMs: 1, size: 1, hash: f.hash },
          },
        };
      },
      async writeFile(request) {
        log.push(
          `write ${request.relPath}${request.create ? ' create' : ''}${request.expectedHash ? ` expect=${request.expectedHash}` : ''}`,
        );
        const f = files[request.relPath];
        if (request.create) {
          if (f) return { ok: false, code: 'changed-on-disk', message: '' };
        } else if (!f) return { ok: false, code: 'not-found', message: '' };
        else if (request.expectedHash && request.expectedHash !== f.hash)
          return { ok: false, code: 'changed-on-disk', message: '' };
        files[request.relPath] = { text: request.text, hash: nextHash(), bom: request.bom };
        return { ok: true, value: { savedAt: 1, version: { mtimeMs: 1, size: 1, hash: 'x' } } };
      },
      async createEntry({ relPath, kind }) {
        log.push(`mkdir ${relPath}`);
        if (kind === 'directory' && folders.has(relPath)) return { ok: false, code: 'exists', message: '' };
        folders.add(relPath);
        return { ok: true, value: { relPath } };
      },
      async renameEntry({ from, to }) {
        log.push(`rename ${from} ${to}`);
        const f = files[from];
        if (!f) return { ok: false, code: 'not-found', message: '' };
        if (files[to]) return { ok: false, code: 'exists', message: '' };
        files[to] = f;
        delete files[from];
        return { ok: true, value: { from, to } };
      },
      async trashEntry({ relPath }) {
        log.push(`trash ${relPath}`);
        const f = files[relPath];
        if (!f) return { ok: false, code: 'not-found', message: '' };
        trash[relPath] = f;
        delete files[relPath];
        return { ok: true, value: null };
      },
    },
    history: {
      async read({ relPath, id }) {
        const v = versions.get(id);
        if (!v || v.relPath !== relPath) return { ok: false, code: 'not-found', message: '' };
        return { ok: true, value: { text: v.text, bom: false } };
      },
      async restoreDeleted({ relPath, id }) {
        log.push(`restore ${relPath}`);
        const v = versions.get(id);
        if (!v || v.relPath !== relPath) return { ok: false, code: 'not-found', message: '' };
        if (files[relPath]) return { ok: false, code: 'exists', message: '' };
        files[relPath] = { text: v.text, hash: nextHash() };
        return { ok: true, value: { relPath } };
      },
      async groupBefore({ relPath }) {
        log.push(`keep ${relPath}`);
        const f = files[relPath];
        return { ok: true, value: f ? { id: keep(relPath, f.text), relPath } : { id: null, relPath: null } };
      },
      async groupRecord({ group, step }: GroupRecordRequest) {
        log.push(`record ${step.kind} ${step.relPath}`);
        const entry = groups.get(group.id) ?? { label: group.label, steps: [], undoneAt: null, seq: (seq += 1) };
        const afterHash = step.kind === 'edit' || step.kind === 'create' ? (files[step.relPath]?.hash ?? null) : null;
        entry.steps.push({ ...step, afterHash });
        groups.set(group.id, entry);
        return { ok: true, value: null };
      },
      async groups() {
        const list: HistoryGroup[] = [...groups.entries()]
          .sort((a, b) => b[1].seq - a[1].seq)
          .map(([id, g]) => ({
            id,
            kind: 'ai-agent',
            label: g.label,
            createdAt: 1,
            undoneAt: g.undoneAt,
            steps: [...g.steps],
            files: [...new Set(g.steps.map((s) => s.to ?? s.relPath))],
          }));
        return { ok: true, value: list };
      },
      async groupUndone({ groupId }) {
        log.push(`undone ${groupId}`);
        const g = groups.get(groupId);
        if (!g) return { ok: false, code: 'not-found', message: '' };
        g.undoneAt = 2;
        return { ok: true, value: null };
      },
    },
    fileOps: {
      async beforeChange(relPath) {
        log.push(`before ${relPath}`);
        return true;
      },
      afterChange(change: FilesChange) {
        log.push(`after ${change.type}`);
      },
      cancelled(relPath) {
        log.push(`cancelled ${relPath}`);
      },
    },
    openTab: (relPath) => {
      const tab = open[relPath];
      return tab
        ? { text: tab.text, readOnly: tab.readOnly ?? false, blocked: tab.blocked ?? false, dirty: tab.dirty ?? false }
        : undefined;
    },
    async saveOpen(relPath) {
      log.push(`save ${relPath}`);
      const tab = open[relPath];
      if (!tab) return false;
      files[relPath] = { text: tab.text, hash: nextHash() };
      tab.dirty = false;
      return true;
    },
    async replaceOpenText(relPath, _before, text) {
      log.push(`tab ${relPath}`);
      const tab = open[relPath];
      if (!tab) return { code: 'changed-since' };
      tab.text = text;
      files[relPath] = { text, hash: nextHash() };
      return null;
    },
    async restoreText(relPath, text, expect) {
      log.push(`restore-version ${relPath}`);
      const current = open[relPath]?.text ?? files[relPath]?.text;
      if (current !== expect) return 'changed';
      if (files[relPath]) keep(relPath, files[relPath].text); // before-restore
      files[relPath] = { text, hash: nextHash() };
      const tab = open[relPath];
      if (tab) tab.text = text;
      return 'restored';
    },
    openFile(relPath) {
      log.push(`open ${relPath}`);
    },
  };
  return { host, log, files, trash, versions, groups };
}
