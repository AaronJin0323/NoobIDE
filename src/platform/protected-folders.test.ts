import { describe, expect, it } from 'vitest';
import { protectedFolderCause, protectedFolderCauseOf, type ProtectedFolderEnv } from './protected-folders';
import { protectedFolderKey } from './labels';

const mac: ProtectedFolderEnv = { platform: 'darwin', home: '/Users/小明 Li' };
const win: ProtectedFolderEnv = { platform: 'win32', home: 'C:\\Users\\小明 Li' };
const linux: ProtectedFolderEnv = { platform: 'linux', home: '/home/xm' };

describe('S25.3: macOS privacy protection (TCC)', () => {
  it.each([
    '/Users/小明 Li/Documents/我的 网页/index.html',
    '/Users/小明 Li/Desktop/site',
    '/Users/小明 Li/Downloads/a.html',
    '/Users/小明 Li/Library/Mobile Documents/com~apple~CloudDocs/网页',
    '/Users/小明 Li/Library/CloudStorage/OneDrive-Personal/x',
    '/Volumes/U 盘/site/index.html',
    '/Users/小明 Li/Documents',
  ])('EPERM in %s is the privacy protection, for reads and writes', (target) => {
    expect(protectedFolderCause('EPERM', target, 'read', mac)).toBe('macos-privacy');
    expect(protectedFolderCause('EPERM', target, 'write', mac)).toBe('macos-privacy');
  });

  it('EACCES (permission bits) is never blamed on TCC', () => {
    expect(protectedFolderCause('EACCES', '/Users/小明 Li/Documents/a.html', 'write', mac)).toBeNull();
  });

  it('EPERM outside the protected folders is not TCC', () => {
    expect(protectedFolderCause('EPERM', '/Users/小明 Li/Projects/a.html', 'write', mac)).toBeNull();
    expect(protectedFolderCause('EPERM', '/Users/小明 Li/DocumentsOld/a.html', 'write', mac)).toBeNull();
    expect(protectedFolderCause('EPERM', '/Users/小明 Li', 'read', mac)).toBeNull();
  });

  it('a redirected known folder from Electron counts too', () => {
    const env = { ...mac, known: { documents: '/Volumes/Data/Docs' } };
    expect(protectedFolderCause('EPERM', '/Volumes/Data/Docs/a', 'read', env)).toBe('macos-privacy');
  });
});

describe('S25.3: Windows Controlled Folder Access', () => {
  it.each([
    'C:\\Users\\小明 Li\\Documents\\我的 网页\\index.html',
    'C:\\Users\\小明 Li\\Desktop\\site\\a.css',
    'C:\\Users\\小明 Li\\Pictures\\x.png',
    'C:\\Users\\小明 Li\\OneDrive\\Documents\\网页\\index.html',
    // NTFS is case-insensitive; nothing is lowercased, the comparison follows Windows rules.
    'c:\\users\\小明 li\\documents\\a.html',
  ])('a refused write in %s is Controlled Folder Access (EPERM and EACCES)', (target) => {
    expect(protectedFolderCause('EPERM', target, 'write', win)).toBe('windows-controlled-folder');
    expect(protectedFolderCause('EACCES', target, 'write', win)).toBe('windows-controlled-folder');
  });

  it('reads are never blocked by Controlled Folder Access', () => {
    expect(protectedFolderCause('EPERM', 'C:\\Users\\小明 Li\\Documents\\a.html', 'read', win)).toBeNull();
  });

  it('Downloads and other folders are not protected by default', () => {
    expect(protectedFolderCause('EPERM', 'C:\\Users\\小明 Li\\Downloads\\a.html', 'write', win)).toBeNull();
    expect(protectedFolderCause('EPERM', 'D:\\网页\\a.html', 'write', win)).toBeNull();
    const env = { ...win, known: { downloads: 'E:\\Downloads' } };
    expect(protectedFolderCause('EPERM', 'E:\\Downloads\\a.html', 'write', env)).toBeNull();
  });

  it('Documents redirected elsewhere (Electron known folder) is protected', () => {
    const env = { ...win, known: { documents: 'D:\\OneDrive - 公司\\文档' } };
    expect(protectedFolderCause('EPERM', 'D:\\OneDrive - 公司\\文档\\site\\a.html', 'write', env)).toBe(
      'windows-controlled-folder',
    );
  });

  it('other errors are not attributed', () => {
    expect(protectedFolderCause('EBUSY', 'C:\\Users\\小明 Li\\Documents\\a.html', 'write', win)).toBeNull();
    expect(protectedFolderCause('ENOSPC', 'C:\\Users\\小明 Li\\Documents\\a.html', 'write', win)).toBeNull();
  });
});

describe('S25.3: probes keep other causes in the same folders apart', () => {
  const listable = (unreadable: readonly string[], missing: readonly string[] = []) => ({
    listError: (dir: string) => (unreadable.includes(dir) ? 'EPERM' : missing.includes(dir) ? 'ENOENT' : null),
    isReadOnlyFile: () => false,
  });

  it('macOS: a refused write counts as TCC only when the folder cannot be listed either', () => {
    const doc = '/Users/小明 Li/Documents/网页';
    const locked = { ...mac, probe: listable([]) };
    expect(protectedFolderCause('EPERM', `${doc}/index.html`, 'write', locked)).toBeNull(); // Finder "Locked"
    const tcc = { ...mac, probe: listable([doc]) };
    expect(protectedFolderCause('EPERM', `${doc}/index.html`, 'write', tcc)).toBe('macos-privacy');
    // A refused read is never a Finder lock: no probe needed.
    expect(protectedFolderCause('EPERM', doc, 'read', locked)).toBe('macos-privacy');
  });

  it('macOS: creating a new folder probes the nearest existing parent', () => {
    const docs = '/Users/小明 Li/Documents';
    const env = { ...mac, probe: listable([docs], [`${docs}/新 项目`]) };
    expect(protectedFolderCause('EPERM', `${docs}/新 项目/css`, 'write', env)).toBe('macos-privacy');
  });

  it('Windows: a file with the read-only attribute is not Controlled Folder Access', () => {
    const env = { ...win, probe: { listError: () => null, isReadOnlyFile: () => true } };
    expect(protectedFolderCause('EPERM', 'C:\\Users\\小明 Li\\Documents\\a.html', 'write', env)).toBeNull();
  });
});

describe('S25.3: error objects', () => {
  it('reads code and path (or rename dest) from a Node fs error', () => {
    const e = Object.assign(new Error('x'), { code: 'EPERM', path: '/tmp/a', dest: '/Users/小明 Li/Desktop/b' });
    expect(protectedFolderCauseOf(e, 'write', mac)).toBe('macos-privacy');
    expect(protectedFolderCauseOf(Object.assign(new Error('x'), { code: 'EPERM' }), 'write', mac)).toBeNull();
    expect(protectedFolderCauseOf('EPERM', 'write', mac)).toBeNull();
    expect(protectedFolderCauseOf(null, 'write', mac)).toBeNull();
  });

  it('nothing is attributed on other platforms', () => {
    expect(protectedFolderCause('EPERM', '/home/xm/Documents/a', 'write', linux)).toBeNull();
  });

  it('each platform has its own explanation key', () => {
    expect(protectedFolderKey('mac')).toBe('protected.mac');
    expect(protectedFolderKey('windows')).toBe('protected.windows');
    expect(protectedFolderKey('other')).toBe('protected.other');
  });
});
