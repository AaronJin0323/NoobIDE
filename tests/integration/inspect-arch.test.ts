// S06.2 — scripts/inspect-arch.mjs against small synthetic Mach-O / PE headers (ADR 0021).
// The fixtures are generated here: a few header bytes are all the script reads, so no real binaries are committed.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SCRIPT = path.resolve(__dirname, '../../scripts/inspect-arch.mjs');

const CPU = { arm64: 0x0100000c, x86_64: 0x01000007, i386: 7 } as const;
const PE = { x64: 0x8664, x86: 0x014c, arm64: 0xaa64 } as const;

/** Thin 64-bit Mach-O header, little endian (what Apple toolchains write) unless `bigEndian`. */
function machO(cpu: number, bigEndian = false): Buffer {
  const b = Buffer.alloc(64);
  if (bigEndian) {
    b.writeUInt32BE(0xfeedfacf, 0);
    b.writeUInt32BE(cpu, 4);
  } else {
    b.writeUInt32LE(0xfeedfacf, 0); // bytes CF FA ED FE
    b.writeUInt32LE(cpu, 4);
  }
  return b;
}

/** Universal binary header (fat or fat64) listing the given slices; slice bodies are not needed. */
function fat(cpus: number[], fat64 = false): Buffer {
  const entry = fat64 ? 32 : 20;
  const b = Buffer.alloc(8 + cpus.length * entry + 16);
  b.writeUInt32BE(fat64 ? 0xcafebabf : 0xcafebabe, 0);
  b.writeUInt32BE(cpus.length, 4);
  cpus.forEach((c, i) => b.writeUInt32BE(c, 8 + i * entry));
  return b;
}

/** Minimal PE: DOS header with e_lfanew, then "PE\0\0" and the COFF Machine field. */
function pe(machine: number, lfanew = 0x80): Buffer {
  const b = Buffer.alloc(lfanew + 24);
  b.write('MZ', 0, 'latin1');
  b.writeUInt32LE(lfanew, 0x3c);
  b.write('PE\0\0', lfanew, 'latin1');
  b.writeUInt16LE(machine, lfanew + 4);
  return b;
}

interface Report {
  scanned: number;
  binaries: number;
  errors: { file: string; reason: string }[];
  warnings: { file: string; reason: string }[];
  files: { file: string; format: string; archs: string[]; level: string }[];
}

function run(args: string[]): { status: number | null; report: Report | null; stderr: string } {
  const r = spawnSync(process.execPath, [SCRIPT, '--json', ...args], { encoding: 'utf8' });
  let report: Report | null;
  try {
    report = JSON.parse(r.stdout) as Report;
  } catch {
    report = null;
  }
  return { status: r.status, report, stderr: r.stderr };
}

let tmp: string;
function dir(name: string, files: Record<string, Buffer | string>): string {
  const d = path.join(tmp, name);
  for (const [rel, content] of Object.entries(files)) {
    const f = path.join(d, rel);
    mkdirSync(path.dirname(f), { recursive: true });
    writeFileSync(f, content);
  }
  return d;
}

beforeAll(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), 'noobide-arch-'));
});
afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe('inspect-arch: macOS app bundles', () => {
  it('passes a bundle whose Mach-O files are all arm64 and ignores other files', () => {
    const d = dir('mac-ok', {
      'NoobIDE.app/Contents/MacOS/noobide': machO(CPU.arm64),
      'NoobIDE.app/Contents/Frameworks/X.framework/Versions/A/X': machO(CPU.arm64, true),
      'NoobIDE.app/Contents/Frameworks/libffmpeg.dylib': fat([CPU.arm64], true),
      'NoobIDE.app/Contents/Info.plist': '<?xml version="1.0"?><plist/>',
      'NoobIDE.app/Contents/Resources/app.asar': Buffer.alloc(256, 7),
      // Java class file shares the 0xCAFEBABE magic; its version word is far above any slice count.
      'NoobIDE.app/Contents/Resources/Foo.class': Buffer.from([0xca, 0xfe, 0xba, 0xbe, 0, 0, 0, 52, 0, 0, 0, 0]),
    });
    const { status, report } = run([d]);
    expect(status).toBe(0);
    expect(report?.scanned).toBe(6);
    expect(report?.binaries).toBe(3);
    expect(report?.files.map((f) => f.archs.join('+'))).toEqual(['arm64', 'arm64', 'arm64']);
  });

  it('fails when one thin Mach-O is x86_64 and names the file', () => {
    const d = dir('mac-x64', {
      'A.app/Contents/MacOS/a': machO(CPU.arm64),
      'A.app/Contents/Frameworks/libx.dylib': machO(CPU.x86_64),
    });
    const { status, report } = run([d]);
    expect(status).toBe(1);
    expect(report?.errors).toHaveLength(1);
    expect(report?.errors[0]?.file).toContain('libx.dylib');
    expect(report?.errors[0]?.reason).toMatch(/x86_64, not arm64/);
  });

  it('fails a 32-bit or big-endian non-arm64 Mach-O', () => {
    const d = dir('mac-i386', { 'B.app/b': machO(CPU.i386, true) });
    expect(run([d]).status).toBe(1);
  });

  it('universal arm64 + x86_64 warns by default and fails with --strict', () => {
    const d = dir('mac-universal', { 'U.app/Contents/MacOS/u': fat([CPU.x86_64, CPU.arm64]) });
    const loose = run([d]);
    expect(loose.status).toBe(0);
    expect(loose.report?.warnings).toHaveLength(1);
    expect(loose.report?.warnings[0]?.reason).toMatch(/also contains x86_64/);
    expect(run(['--strict', d]).status).toBe(1);
  });

  it('fails a universal binary without an arm64 slice', () => {
    const d = dir('mac-fat-intel', { 'I.app/i': fat([CPU.i386, CPU.x86_64]) });
    const { status, report } = run([d]);
    expect(status).toBe(1);
    expect(report?.errors[0]?.reason).toMatch(/without an arm64 slice/);
  });

  it.skipIf(process.platform === 'win32')('does not follow symbolic links', () => {
    const d = dir('mac-symlink', { 'S.app/Versions/A/S': machO(CPU.arm64) });
    const outside = dir('outside', { bad: machO(CPU.x86_64) });
    symlinkSync(path.join(outside, 'bad'), path.join(d, 'S.app', 'link'));
    const { status, report } = run([d]);
    expect(status).toBe(0);
    expect(report?.binaries).toBe(1);
  });
});

describe('inspect-arch: Windows app directories', () => {
  it('passes x64 PE files (exe and dll)', () => {
    const d = dir('win-ok', {
      'noobide.exe': pe(PE.x64),
      'ffmpeg.dll': pe(PE.x64, 0x100),
      'resources/app.asar': Buffer.alloc(64, 1),
      LICENSE: 'MIT',
    });
    const { status, report } = run([d]);
    expect(status).toBe(0);
    expect(report?.binaries).toBe(2);
    expect(report?.files.every((f) => f.format === 'pe' && f.archs[0] === 'x64')).toBe(true);
  });

  it.each([
    ['x86', PE.x86],
    ['arm64', PE.arm64],
  ])('fails a %s PE', (name, machine) => {
    const d = dir(`win-${name}`, { 'noobide.exe': pe(PE.x64), 'bad.dll': pe(machine) });
    const { status, report } = run([d]);
    expect(status).toBe(1);
    expect(report?.errors[0]?.reason).toBe(`PE is ${name}, not x64`);
  });

  it('ignores an MZ file without a PE signature', () => {
    const notPe = pe(PE.x86);
    notPe.write('XX', 0x80, 'latin1');
    const d = dir('win-dos', { 'noobide.exe': pe(PE.x64), 'old.com': notPe });
    expect(run([d]).report?.binaries).toBe(1);
  });
});

describe('inspect-arch: usage', () => {
  it('handles paths with Chinese characters and spaces', () => {
    const d = dir('我的 应用', { '网页 工具.app/Contents/MacOS/x': machO(CPU.arm64) });
    expect(run([d]).status).toBe(0);
  });

  it('exits 2 when no native binary is found (wrong path guard)', () => {
    const d = dir('empty', { 'readme.txt': 'hi' });
    expect(run([d]).status).toBe(2);
  });

  it('exits 2 for a missing path', () => {
    expect(run([path.join(tmp, 'does-not-exist')]).status).toBe(2);
  });
});
