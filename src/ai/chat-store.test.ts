import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AiChatToSave, AiSavedTurn } from '../shared/ipc/ai-history-contract';
import { projectKey } from '../recovery/keys';
import { AiChatStore, CORRUPT_SUFFIX } from './chat-store';

/** S39.1: saved chats per project in app data — atomic writes, caps with oldest-first pruning, damaged files. */
const ID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const SECRET = 'CHAT-TEXT-MARKER';

function turn(prompt: string, answer = 'answer', extra: Partial<AiSavedTurn> = {}): AiSavedTurn {
  return {
    kind: 'chat',
    mode: 'chat',
    prompt,
    context: [{ kind: 'file', relPath: '页面/index.html' }],
    status: 'done',
    parts: [{ kind: 'text', text: answer }],
    usage: { inputTokens: 12, outputTokens: 3 },
    ...extra,
  };
}

const chat = (n: number, turns: AiSavedTurn[] = [turn(`question ${n}`)]): AiChatToSave => ({
  id: ID(n),
  title: `chat ${n}`,
  turns,
});

let dir: string;
let appData: string;
let root: string;
let clock: number;
let logged: string[];

function store(limits: ConstructorParameters<typeof AiChatStore>[0]['limits'] = {}) {
  return new AiChatStore({
    dir: path.join(appData, 'ai-chats'),
    limits,
    now: () => clock,
    log: (event, fields) => logged.push(`${event} ${JSON.stringify(fields)}`),
  });
}

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'noobide-chats-'));
  appData = path.join(dir, '用户 数据');
  root = path.join(dir, '我的 项目');
  await mkdir(root, { recursive: true });
  clock = 1_700_000_000_000;
  logged = [];
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('AiChatStore (S39.1)', () => {
  it('saves a chat in app data under the project hash, never in the project folder, and reads it back', async () => {
    const s = store();
    const saved = await s.save(root, chat(1, [turn(`${SECRET} 你好`)]));
    expect(saved).toMatchObject({ ok: true, value: { id: ID(1), title: 'chat 1', turnCount: 1, createdAt: clock } });
    // The project folder is untouched; the file sits under a hashed folder name in app data.
    expect(await readdir(root)).toEqual([]);
    const folder = path.join(appData, 'ai-chats', projectKey(root));
    expect(s.projectDir(root)).toBe(folder);
    expect(await readdir(folder)).toEqual([`${ID(1)}.json`]);
    expect(folder).not.toContain('我的 项目');
    const back = await s.get(root, ID(1));
    expect(back?.turns[0]?.prompt).toBe(`${SECRET} 你好`);
    expect(await s.list(root)).toEqual({
      chats: [{ id: ID(1), title: 'chat 1', createdAt: clock, updatedAt: clock, turnCount: 1 }],
      skipped: 0,
    });
    // Saving again replaces the chat and keeps its creation date.
    clock += 1000;
    await s.save(root, chat(1, [turn('a'), turn('b')]));
    expect(await s.list(root)).toMatchObject({ chats: [{ createdAt: clock - 1000, updatedAt: clock, turnCount: 2 }] });
    // Another project's chats are separate.
    const other = path.join(dir, 'other');
    expect((await s.list(other)).chats).toEqual([]);
    expect(logged.join('\n')).not.toContain(SECRET);
  });

  it('writes atomically: no temp file is left, and a failed write keeps the previous file', async () => {
    const s = store();
    await s.save(root, chat(1, [turn('first')]));
    const folder = s.projectDir(root);
    const before = await readFile(path.join(folder, `${ID(1)}.json`), 'utf8');
    // A directory in place of the temp target's folder makes the write fail.
    await rm(folder, { recursive: true });
    await writeFile(folder, 'not a folder');
    const failed = await s.save(root, chat(1, [turn('second')]));
    expect(failed).toMatchObject({ ok: false, code: 'write-failed' });
    await rm(folder);
    await mkdir(folder);
    await writeFile(path.join(folder, `${ID(1)}.json`), before);
    await writeFile(path.join(folder, `.${ID(1)}.json.123.noobide-tmp`), 'half');
    expect((await s.get(root, ID(1)))?.turns[0]?.prompt).toBe('first');
    await s.list(root); // a scan removes crash leftovers
    expect(await readdir(folder)).toEqual([`${ID(1)}.json`]);
    expect(logged.some((l) => l.startsWith('ai-chat-write-failed'))).toBe(true);
  });

  it('keeps at most N chats per project and prunes the least recently updated first', async () => {
    const s = store({ maxChatsPerProject: 3 });
    for (let n = 1; n <= 5; n += 1) {
      clock += 1000;
      await s.save(root, chat(n));
    }
    expect((await s.list(root)).chats.map((c) => c.id)).toEqual([ID(5), ID(4), ID(3)]);
    // Updating an old chat makes it the newest; the oldest other one goes.
    clock += 1000;
    await s.save(root, chat(3, [turn('more'), turn('again')]));
    clock += 1000;
    await s.save(root, chat(6));
    expect((await s.list(root)).chats.map((c) => c.id)).toEqual([ID(6), ID(3), ID(5)]);
    expect(logged.some((l) => l.startsWith('ai-chats-pruned'))).toBe(true);
  });

  it('caps the bytes per project (oldest pruned) and per chat (oldest turns dropped; too large refused)', async () => {
    const big = 'x'.repeat(4000);
    const s = store({ maxBytesPerProject: 10_000, maxBytesPerChat: 9_000 });
    for (let n = 1; n <= 4; n += 1) {
      clock += 1000;
      await s.save(root, chat(n, [turn(`q${n}`, big)]));
    }
    // ~4.2 kB each: only two fit in 10 kB; the chat just saved is always kept.
    expect((await s.list(root)).chats.map((c) => c.id)).toEqual([ID(4), ID(3)]);

    // A long chat keeps its newest turns.
    clock += 1000;
    const long = await s.save(root, chat(7, [turn('t1', big), turn('t2', big), turn('t3', big), turn('t4', 'short')]));
    expect(long.ok).toBe(true);
    const kept = await s.get(root, ID(7));
    expect(kept?.turns.at(-1)?.prompt).toBe('t4');
    expect(kept?.turns.length).toBeLessThan(4);
    // One turn alone over the cap cannot be saved.
    expect(await s.save(root, chat(8, [turn('huge', 'y'.repeat(20_000))]))).toMatchObject({
      ok: false,
      code: 'too-large',
    });
  });

  it('skips damaged files with a count (moved aside), leaves newer-version files alone, never crashes', async () => {
    const s = store();
    await s.save(root, chat(1));
    const folder = s.projectDir(root);
    await writeFile(path.join(folder, `${ID(2)}.json`), '{ not json');
    await writeFile(path.join(folder, `${ID(3)}.json`), JSON.stringify({ version: 1, id: ID(3), title: 1 }));
    // A body naming another chat is damage too.
    const valid = JSON.parse(await readFile(path.join(folder, `${ID(1)}.json`), 'utf8')) as object;
    await writeFile(path.join(folder, `${ID(4)}.json`), JSON.stringify(valid));
    const newer = JSON.stringify({ ...valid, id: ID(5), version: 99, extra: 'from the future' });
    await writeFile(path.join(folder, `${ID(5)}.json`), newer);
    await writeFile(path.join(folder, 'notes.txt'), 'ignored');

    const list = await s.list(root);
    expect(list.chats.map((c) => c.id)).toEqual([ID(1)]);
    expect(list.skipped).toBe(4);
    const names = await readdir(folder);
    for (const n of [2, 3, 4]) expect(names).toContain(`${ID(n)}.json${CORRUPT_SUFFIX}`);
    expect(await readFile(path.join(folder, `${ID(5)}.json`), 'utf8')).toBe(newer);
    expect(await s.get(root, ID(2))).toBeNull();
    // The next list no longer counts the moved-aside files; the newer one stays skipped.
    expect((await s.list(root)).skipped).toBe(1);
    // A newer file is never overwritten.
    expect(await s.save(root, chat(5))).toMatchObject({ ok: false, code: 'write-failed' });
    expect(await readFile(path.join(folder, `${ID(5)}.json`), 'utf8')).toBe(newer);
  });

  it('deletes one chat, or all of a project, and refuses ids that are not chat ids', async () => {
    const s = store();
    await s.save(root, chat(1));
    clock += 1;
    await s.save(root, chat(2));
    expect(await s.count(root)).toBe(2);
    expect(await s.delete(root, ID(1))).toBe(true);
    expect((await s.list(root)).chats.map((c) => c.id)).toEqual([ID(2)]);
    expect(await s.delete(root, '../../evil')).toBe(false);
    expect(await s.get(root, '../x')).toBeNull();
    expect(await s.deleteAll(root)).toBe(1);
    expect(await s.count(root)).toBe(0);
    await expect(readdir(s.projectDir(root))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(logged.join('\n')).not.toContain('question');
  });
});
