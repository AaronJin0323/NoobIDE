import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { toIpcResult } from '../../src/shared/ipc/contract';
import { ProjectService } from '../../src/workspace/project-service';
import { DocumentSaver } from '../../src/renderer/workbench/save-controller';
import { saveWithFormat, type FormatOutcome } from '../../src/renderer/workbench/format-on-save';

/**
 * S53.4 format on save, from the saver to the atomic write on a real folder: the bytes on disk are the formatted text
 * when it is on, the unformatted text when it is off or when formatting fails (and the reason is reported).
 * "The editor" is simulated the way the workbench is wired: a format is an edit of the buffer, which reaches the saver
 * through the editor's change event (recordEdit → saver.edit).
 */
let tmp: string;
let root: string;
const MESSY = '<ul><li>One</li></ul>\n';
const FORMATTED = '<ul>\n  <li>One</li>\n</ul>\n';

beforeEach(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), 'noobide-format-save-'));
  root = path.join(tmp, '格式 练习');
  await mkdir(root, { recursive: true });
  await writeFile(path.join(root, 'index.html'), '');
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

async function setup() {
  const service = new ProjectService({ atomic: { syncDirectory: false } });
  const opened = await service.open(root);
  if (!opened.ok) throw new Error(opened.message);
  const projectId = opened.value.projectId;
  const saver = new DocumentSaver({
    initialText: '',
    autosave: false,
    write: async (text) => {
      const result = toIpcResult(await service.write({ projectId, relPath: 'index.html', text, bom: false }));
      return result.ok ? { ok: true } : { ok: false, code: result.code, message: result.message };
    },
  });
  saver.edit(MESSY); // typed in the editor, not saved yet
  const onDisk = () => readFile(path.join(root, 'index.html'), 'utf8');
  return { saver, onDisk };
}

describe('format on save (S53.4)', () => {
  it('off (the default): the file is saved as typed and the formatter is not asked', async () => {
    const { saver, onDisk } = await setup();
    const format = vi.fn(async (): Promise<FormatOutcome> => ({ ok: true }));
    const failed = vi.fn();
    expect(await saveWithFormat({ enabled: false, format, save: () => saver.save(), onFormatFailed: failed })).toBe(
      true,
    );
    expect(await onDisk()).toBe(MESSY);
    expect(format).not.toHaveBeenCalled();
    expect(failed).not.toHaveBeenCalled();
  });

  it('on: the saved bytes are the formatted text', async () => {
    const { saver, onDisk } = await setup();
    const order: string[] = [];
    const ok = await saveWithFormat({
      enabled: true,
      format: async () => {
        order.push('format');
        saver.edit(FORMATTED); // the editor's formatting edit, reported like any edit
        return { ok: true };
      },
      save: () => {
        order.push('save');
        return saver.save();
      },
      onFormatFailed: () => order.push('failed'),
    });
    expect(ok).toBe(true);
    expect(order).toEqual(['format', 'save']);
    expect(await onDisk()).toBe(FORMATTED);
    expect(saver.state.revision).toBe(2); // one edit typed, one format edit: the save itself is no edit
  });

  it('a formatter that fails: the unformatted text is saved and the reason is reported', async () => {
    const { saver, onDisk } = await setup();
    const failed = vi.fn();
    const ok = await saveWithFormat({
      enabled: true,
      format: async () => ({ ok: false, reason: 'failed' }),
      save: () => saver.save(),
      onFormatFailed: failed,
    });
    expect(ok).toBe(true);
    expect(await onDisk()).toBe(MESSY);
    expect(failed).toHaveBeenCalledWith('failed');
  });

  it('a formatter that throws or hangs: saved unformatted, reported as failed / timeout', async () => {
    const { saver, onDisk } = await setup();
    const failed = vi.fn();
    await saveWithFormat({
      enabled: true,
      format: () => Promise.reject(new Error('worker crashed')),
      save: () => saver.save(),
      onFormatFailed: failed,
    });
    expect(await onDisk()).toBe(MESSY);
    saver.edit(`${MESSY}<p>more</p>\n`);
    await saveWithFormat({
      enabled: true,
      format: () => new Promise<FormatOutcome>(() => undefined), // never answers
      save: () => saver.save(),
      onFormatFailed: failed,
      timeoutMs: 50,
    });
    expect(await onDisk()).toBe(`${MESSY}<p>more</p>\n`);
    expect(failed.mock.calls).toEqual([['failed'], ['timeout']]);
  });

  it('a file without a formatter is saved as it is, with nothing to report', async () => {
    const { saver, onDisk } = await setup();
    const failed = vi.fn();
    await saveWithFormat({
      enabled: true,
      format: async () => ({ ok: false, reason: 'unsupported' }),
      save: () => saver.save(),
      onFormatFailed: failed,
    });
    expect(await onDisk()).toBe(MESSY);
    expect(failed).not.toHaveBeenCalled();
  });
});
