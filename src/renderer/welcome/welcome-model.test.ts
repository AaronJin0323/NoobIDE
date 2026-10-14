import { describe, expect, it } from 'vitest';
import type { NoobideApi } from '../../shared/ipc/contract';
import { translate, type MessageKey } from '../i18n/index';
import {
  createErrorMessage,
  recentProjectsSource,
  recentRowView,
  topLevelEntries,
  wizardView,
  type WizardInput,
} from './welcome-model';

const zh = (key: MessageKey) => translate('zh-CN', key);
const en = (key: MessageKey) => translate('en', key);

const ready: WizardInput = {
  templateId: 'personal-intro',
  name: '我的 主页',
  hasLocation: true,
  check: { state: 'ok', folderPath: 'C:\\Users\\林小雨\\Documents\\NoobIDE 项目\\我的 主页' },
  creating: false,
};

describe('create wizard view (S20.2)', () => {
  it('offers "Create and open" only when the name is legal, a location is chosen and main found the name free', () => {
    const view = wizardView(zh, ready);
    expect(view).toEqual({
      message: null,
      messageKind: null,
      folderPath: 'C:\\Users\\林小雨\\Documents\\NoobIDE 项目\\我的 主页',
      canCreate: true,
    });
    expect(wizardView(zh, { ...ready, templateId: null }).canCreate).toBe(false);
    expect(wizardView(zh, { ...ready, creating: true })).toMatchObject({
      canCreate: false,
      message: '正在创建…',
      messageKind: 'progress',
    });
  });

  it('explains illegal names immediately, before asking main, using the shared name rules', () => {
    const view = wizardView(zh, { ...ready, name: 'CON', check: { state: 'checking' } });
    expect(view.canCreate).toBe(false);
    expect(view.messageKind).toBe('error');
    expect(view.message).toContain('Windows');
    expect(wizardView(en, { ...ready, name: 'a<b' }).message).toContain('<');
    expect(wizardView(zh, { ...ready, name: '' }).message).toBe('请输入名称。');
  });

  it('shows the collision message of the wireframe and keeps Create disabled', () => {
    const view = wizardView(zh, { ...ready, check: { state: 'error', code: 'exists', message: '我的 主页' } });
    expect(view).toMatchObject({ canCreate: false, messageKind: 'error', folderPath: null });
    expect(view.message).toBe('已有同名文件夹或文件“我的 主页”。请换一个名字——我们不会覆盖已有文件。');
    const caseView = wizardView(en, {
      ...ready,
      name: 'my site',
      check: { state: 'error', code: 'case-conflict', message: 'My Site' },
    });
    expect(caseView.message).toContain('“My Site”');
    expect(caseView.message).toContain('letter case');
  });

  it('says it is checking while main has not answered, and asks for a location when there is none', () => {
    expect(wizardView(zh, { ...ready, check: { state: 'checking' } })).toMatchObject({
      canCreate: false,
      messageKind: 'progress',
      message: '正在检查名字…',
    });
    expect(wizardView(zh, { ...ready, hasLocation: false })).toMatchObject({ canCreate: false, messageKind: 'error' });
  });

  it('has an explanation for every create error, in both languages', () => {
    const codes = [
      'invalid-name',
      'exists',
      'case-conflict',
      'location-missing',
      'unknown-location',
      'unknown-template',
      'permission-denied',
      'disk-full',
      'template-broken',
      'create-failed',
      'list-failed',
      'templates-unavailable',
      'invalid-request',
      'forbidden-sender',
    ] as const;
    for (const t of [zh, en]) {
      for (const code of codes) {
        const text = createErrorMessage(t, code, 'x', 'CON');
        expect(text.trim(), code).not.toBe('');
        expect(text, code).not.toMatch(/\{\w+\}/);
      }
    }
    expect(createErrorMessage(zh, 'disk-full', 'ENOSPC', 'a')).toBe('磁盘空间不足，项目没有创建。');
  });

  it('lists the top-level entries a template creates', () => {
    expect(topLevelEntries(['index.html', 'style.css', 'script.js', 'images/avatar.svg', 'images/b.svg'])).toEqual([
      'index.html',
      'style.css',
      'script.js',
      'images/',
    ]);
  });
});

describe('recent projects on the welcome screen (S20.2, store from S13.3)', () => {
  it('an available project is opened; a missing folder says so in text and can only be removed from the list', () => {
    expect(recentRowView({ id: '1', name: '我的主页', path: 'D:\\网页练习\\我的 主页', available: true })).toEqual({
      statusKey: null,
      action: 'open',
      actionKey: 'welcome.recentOpen',
    });
    const missing = recentRowView({ id: '2', name: '旧项目', path: 'E:\\已拔出的U盘\\旧项目', available: false });
    expect(missing).toEqual({
      statusKey: 'welcome.recentMissing',
      action: 'remove',
      actionKey: 'welcome.recentRemove',
    });
    expect(zh(missing.statusKey as MessageKey)).toBe('找不到文件夹');
    expect(en(missing.statusKey as MessageKey)).toBe('Folder not found');
  });

  it('is shown only when the bridge provides a complete recent-projects API', () => {
    const base = {} as NoobideApi;
    expect(recentProjectsSource(undefined)).toBeUndefined();
    expect(recentProjectsSource(base)).toBeUndefined();
    expect(recentProjectsSource({ ...base, recentProjects: { list: async () => [] } } as never)).toBeUndefined();
    const api = { list: async () => [], open: async () => null, remove: async () => undefined };
    expect(recentProjectsSource({ ...base, recentProjects: api } as never)).toBe(api);
  });
});
