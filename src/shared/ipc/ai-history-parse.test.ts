import { describe, expect, it } from 'vitest';
import {
  parseChatRef,
  parseNoPayload,
  parseProjectOnly,
  parseSaveChat,
  parseSavedChatFile,
  parseSetDailyBudget,
} from './ai-history-parse';

/** S39: every saved-chat / usage payload is checked in main (exact keys, known values, bounded sizes). */
const PROJECT = '3f1c2a9e-8b7d-4c6e-9f00-1a2b3c4d5e6f';
const CHAT = '00000000-0000-4000-8000-000000000001';

const turn = {
  kind: 'agent',
  mode: 'chat',
  prompt: '加一个关于页面',
  context: [
    { kind: 'file', relPath: '中文 文件夹/index.html' },
    { kind: 'selection', relPath: 'a.js', startLine: 2, endLine: 4 },
    { kind: 'problem', label: 'x is not defined' },
  ],
  status: 'done',
  parts: [
    { kind: 'text', text: 'Sure.' },
    { kind: 'step', tool: 'read_file', summary: 'index.html' },
    {
      kind: 'proposal',
      reason: 'Add a page.',
      changes: [
        { kind: 'create', relPath: 'about.html' },
        { kind: 'rename', relPath: 'a.txt', to: 'b.txt' },
      ],
    },
  ],
  usage: { inputTokens: 1200, outputTokens: 40 },
};
const chat = { id: CHAT, title: 'About page', turns: [turn] };

describe('saved chat parsers (S39.1)', () => {
  it('accepts a chat as the contract defines it', () => {
    expect(parseSaveChat({ projectId: PROJECT, chat })).toEqual({ projectId: PROJECT, chat });
    expect(
      parseSaveChat({
        projectId: PROJECT,
        chat: { ...chat, turns: [{ ...turn, status: 'error', errorCode: 'offline' }] },
      }),
    ).not.toBeNull();
    const file = { version: 1, ...chat, createdAt: 1, updatedAt: 2 };
    expect(parseSavedChatFile(file)).toEqual({ ...chat, createdAt: 1, updatedAt: 2 });
  });

  it.each([
    ['extra key', { projectId: PROJECT, chat, more: 1 }],
    ['bad project id', { projectId: '../x', chat }],
    ['bad chat id', { projectId: PROJECT, chat: { ...chat, id: '../../evil' } }],
    ['no turns', { projectId: PROJECT, chat: { ...chat, turns: [] } }],
    ['running turn', { projectId: PROJECT, chat: { ...chat, turns: [{ ...turn, status: 'streaming' }] } }],
    [
      'code text in context',
      {
        projectId: PROJECT,
        chat: { ...chat, turns: [{ ...turn, context: [{ kind: 'file', relPath: 'a', text: 'x' }] }] },
      },
    ],
    [
      'escaping path',
      { projectId: PROJECT, chat: { ...chat, turns: [{ ...turn, context: [{ kind: 'file', relPath: '../a' }] }] } },
    ],
    [
      'proposal contents',
      {
        projectId: PROJECT,
        chat: {
          ...chat,
          turns: [
            {
              ...turn,
              parts: [{ kind: 'proposal', reason: '', changes: [{ kind: 'edit', relPath: 'a', after: 'x' }] }],
            },
          ],
        },
      },
    ],
    [
      'rename without target',
      {
        projectId: PROJECT,
        chat: {
          ...chat,
          turns: [{ ...turn, parts: [{ kind: 'proposal', reason: '', changes: [{ kind: 'rename', relPath: 'a' }] }] }],
        },
      },
    ],
    [
      'unknown part',
      { projectId: PROJECT, chat: { ...chat, turns: [{ ...turn, parts: [{ kind: 'html', html: '<b>' }] }] } },
    ],
    [
      'negative tokens',
      { projectId: PROJECT, chat: { ...chat, turns: [{ ...turn, usage: { inputTokens: -1, outputTokens: 0 } }] } },
    ],
    ['long prompt', { projectId: PROJECT, chat: { ...chat, turns: [{ ...turn, prompt: 'x'.repeat(40_000) }] } }],
    ['too many turns', { projectId: PROJECT, chat: { ...chat, turns: Array.from({ length: 201 }, () => turn) } }],
    ['odd error code', { projectId: PROJECT, chat: { ...chat, turns: [{ ...turn, errorCode: '<script>' }] } }],
  ])('refuses %s', (_name, payload) => {
    expect(parseSaveChat(payload)).toBeNull();
  });

  it('checks the file shape too (dates, exact keys)', () => {
    expect(parseSavedChatFile({ version: 1, ...chat, createdAt: -1, updatedAt: 2 })).toBeNull();
    expect(parseSavedChatFile({ version: 1, ...chat, createdAt: 1 })).toBeNull();
    expect(parseSavedChatFile({ version: 1, ...chat, createdAt: 1, updatedAt: 2, path: 'C:\\x' })).toBeNull();
    expect(parseSavedChatFile('nope')).toBeNull();
  });

  it('checks the small payloads', () => {
    expect(parseProjectOnly({ projectId: PROJECT })).toEqual({ projectId: PROJECT });
    expect(parseProjectOnly({ projectId: PROJECT, x: 1 })).toBeNull();
    expect(parseChatRef({ projectId: PROJECT, chatId: CHAT })).toEqual({ projectId: PROJECT, chatId: CHAT });
    expect(parseChatRef({ projectId: PROJECT, chatId: 'conv1' })).toBeNull();
    expect(parseNoPayload(undefined)).toEqual({});
    expect(parseNoPayload({})).toEqual({});
    expect(parseNoPayload({ a: 1 })).toBeNull();
  });
});

describe('daily budget parser (S39.2)', () => {
  it('accepts null (off) or a whole number in range', () => {
    expect(parseSetDailyBudget({ dailyTokens: null })).toEqual({ dailyTokens: null });
    expect(parseSetDailyBudget({ dailyTokens: 200_000 })).toEqual({ dailyTokens: 200_000 });
    for (const bad of [999, 1.5, -1, 2_000_000_000, '5000', undefined]) {
      expect(parseSetDailyBudget({ dailyTokens: bad })).toBeNull();
    }
    expect(parseSetDailyBudget({})).toBeNull();
    expect(parseSetDailyBudget({ dailyTokens: 5000, extra: true })).toBeNull();
  });
});
