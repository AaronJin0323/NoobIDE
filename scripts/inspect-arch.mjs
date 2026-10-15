#!/usr/bin/env node
// S06.2 — architecture inspection of packaged builds (docs/decisions/0021-ci-matrix-and-arch-inspection.md).
//
//   node scripts/inspect-arch.mjs                 inspect every packaged app directory in out/ (not out/make)
//   node scripts/inspect-arch.mjs <path> [...]    inspect the given files / directories
//   node scripts/inspect-arch.mjs --json …        machine-readable report on stdout
//   node scripts/inspect-arch.mjs --strict …      also fail universal (fat) Mach-O binaries that carry extra slices
//
// Every regular file is classified by its header, never by its name:
//   • Mach-O (thin, 32/64-bit, either byte order) must be arm64.
//   • Mach-O universal (fat / fat64) must contain an arm64 slice. Extra slices (e.g. x86_64) are reported as a
//     warning, and are an error with --strict (policy: ADR 0021).
//   • Windows PE (MZ + PE\0\0 COFF header) must be x64 (IMAGE_FILE_MACHINE_AMD64).
// Symbolic links are not followed (macOS frameworks are full of them; the targets are inspected once anyway).
// Exit codes: 0 pass · 1 a binary has the wrong architecture · 2 usage error or no native binary found.
// Pure Node, no dependencies, runs on macOS, Windows and Linux.
import { closeSync, lstatSync, openSync, readdirSync, readSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CPU_ARCH_ABI64 = 0x01000000;
const CPU_TYPE_X86 = 7;
const CPU_TYPE_ARM = 12;
const CPU_TYPE_POWERPC = 18;
const MACHO_CPU = {
  [CPU_TYPE_X86]: 'i386',
  [CPU_TYPE_X86 | CPU_ARCH_ABI64]: 'x86_64',
  [CPU_TYPE_ARM]: 'arm',
  [CPU_TYPE_ARM | CPU_ARCH_ABI64]: 'arm64',
  [CPU_TYPE_ARM | 0x02000000]: 'arm64_32',
  [CPU_TYPE_POWERPC]: 'ppc',
  [CPU_TYPE_POWERPC | CPU_ARCH_ABI64]: 'ppc64',
};
const PE_MACHINE = {
  0x014c: 'x86',
  0x8664: 'x64',
  0xaa64: 'arm64',
  0xa641: 'arm64ec',
  0x01c4: 'arm',
  0x0200: 'ia64',
};

const hex = (n) => `0x${n.toString(16)}`;

/** Reads up to `length` bytes at `position`; returns a (possibly shorter) Buffer. */
function readAt(fd, position, length) {
  const buf = Buffer.alloc(length);
  const n = readSync(fd, buf, 0, length, position);
  return buf.subarray(0, n);
}

/**
 * Classifies one file by its header. Returns null for files that are neither Mach-O nor PE, otherwise
 * { format: 'macho' | 'macho-fat' | 'pe', archs: string[] }.
 */
export function classifyFile(file) {
  const fd = openSync(file, 'r');
  try {
    return classifyFd(fd);
  } finally {
    closeSync(fd);
  }
}

function classifyFd(fd) {
  const head = readAt(fd, 0, 64);
  if (head.length < 8) return null;
  const be = head.readUInt32BE(0);

  // Thin Mach-O. MH_MAGIC / MH_MAGIC_64 in file byte order; the cputype follows in the same byte order.
  if (be === 0xfeedface || be === 0xfeedfacf) return thin(head.readUInt32BE(4));
  if (be === 0xcefaedfe || be === 0xcffaedfe) return thin(head.readUInt32LE(4));

  // Universal (fat) Mach-O: big-endian header. 0xCAFEBABE is also the Java class-file magic; a class file has its
  // major version (≥ 45) in the low half of the next word, so a real fat header has a small slice count.
  if (be === 0xcafebabe || be === 0xcafebabf) {
    const nfat = head.readUInt32BE(4);
    if (nfat === 0 || nfat > 30) return null;
    const entrySize = be === 0xcafebabf ? 32 : 20;
    const table = readAt(fd, 8, nfat * entrySize);
    if (table.length < nfat * entrySize) return null;
    const archs = [];
    for (let i = 0; i < nfat; i++) archs.push(cpuName(table.readUInt32BE(i * entrySize)));
    return { format: 'macho-fat', archs };
  }

  // Windows PE: DOS header "MZ", e_lfanew at 0x3C, then "PE\0\0" and the COFF Machine field.
  if (head[0] === 0x4d && head[1] === 0x5a) {
    const lfanew = head.length >= 0x40 ? head.readUInt32LE(0x3c) : -1;
    if (lfanew < 0x40 || lfanew > 0x10000000) return null;
    const pe = readAt(fd, lfanew, 6);
    if (pe.length < 6 || pe.readUInt32BE(0) !== 0x50450000) return null;
    const machine = pe.readUInt16LE(4);
    return { format: 'pe', archs: [PE_MACHINE[machine] ?? `unknown(${hex(machine)})`] };
  }
  return null;
}

function cpuName(cputype) {
  return MACHO_CPU[cputype] ?? `unknown(${hex(cputype)})`;
}

function thin(cputype) {
  return { format: 'macho', archs: [cpuName(cputype)] };
}

/** Applies the architecture policy to one classified file. */
export function judge(info, { strict = false } = {}) {
  if (info.format === 'pe') {
    return info.archs[0] === 'x64' ? { level: 'ok' } : { level: 'error', reason: `PE is ${info.archs[0]}, not x64` };
  }
  if (info.format === 'macho') {
    return info.archs[0] === 'arm64'
      ? { level: 'ok' }
      : { level: 'error', reason: `Mach-O is ${info.archs[0]}, not arm64` };
  }
  // Universal binary.
  if (!info.archs.includes('arm64')) {
    return { level: 'error', reason: `universal Mach-O without an arm64 slice (${info.archs.join(', ')})` };
  }
  const extra = info.archs.filter((a) => a !== 'arm64');
  if (extra.length === 0) return { level: 'ok' };
  const reason = `universal Mach-O also contains ${extra.join(', ')}`;
  return strict ? { level: 'error', reason } : { level: 'warning', reason };
}

function* walk(p) {
  const st = lstatSync(p);
  if (st.isSymbolicLink()) return;
  if (st.isDirectory()) {
    for (const name of readdirSync(p).sort()) yield* walk(path.join(p, name));
  } else if (st.isFile()) {
    yield p;
  }
}

/** Inspects the given roots; returns the report object (also used by tests through --json). */
export function inspect(roots, { strict = false } = {}) {
  const files = [];
  let scanned = 0;
  for (const root of roots) {
    for (const file of walk(root)) {
      scanned++;
      const info = classifyFile(file);
      if (!info) continue;
      files.push({ file, ...info, ...judge(info, { strict }) });
    }
  }
  return {
    scanned,
    binaries: files.length,
    errors: files.filter((f) => f.level === 'error'),
    warnings: files.filter((f) => f.level === 'warning'),
    files,
  };
}

/** Default roots: the packaged app directories electron-forge writes to out/ (out/make holds installers). */
function defaultRoots(outDir) {
  if (!existsSync(outDir)) return [];
  return readdirSync(outDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith('make'))
    .map((d) => path.join(outDir, d.name));
}

function main(argv) {
  const json = argv.includes('--json');
  const strict = argv.includes('--strict');
  const unknown = argv.filter((a) => a.startsWith('--') && a !== '--json' && a !== '--strict');
  if (unknown.length) {
    console.error(`inspect-arch: unknown option ${unknown.join(' ')}`);
    return 2;
  }
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const args = argv.filter((a) => !a.startsWith('--'));
  const roots = args.length ? args.map((a) => path.resolve(a)) : defaultRoots(path.join(root, 'out'));
  const missing = roots.filter((r) => !existsSync(r));
  if (roots.length === 0 || missing.length) {
    console.error(
      missing.length
        ? `inspect-arch: not found: ${missing.join(', ')}`
        : 'inspect-arch: nothing to inspect — run `npm run package` (or `npm run make`) first.',
    );
    return 2;
  }

  const report = inspect(roots, { strict });
  if (json) {
    console.log(JSON.stringify({ roots, ...report }, null, 2));
  } else {
    console.log(`inspect-arch: ${roots.join(', ')}`);
    for (const f of report.files) {
      const mark = f.level === 'ok' ? 'ok  ' : f.level === 'warning' ? 'warn' : 'FAIL';
      const rel = path.relative(process.cwd(), f.file) || f.file;
      console.log(
        `  ${mark} ${f.format.padEnd(9)} ${f.archs.join('+').padEnd(14)} ${rel}${f.reason ? ` — ${f.reason}` : ''}`,
      );
    }
    console.log(
      `${report.scanned} files scanned, ${report.binaries} native binaries, ${report.errors.length} errors, ` +
        `${report.warnings.length} warnings`,
    );
  }
  if (report.binaries === 0) {
    console.error('inspect-arch: no Mach-O or PE binary found — wrong path?');
    return 2;
  }
  if (report.errors.length) {
    console.error(`inspect-arch FAILED: ${report.errors.length} binaries have the wrong architecture.`);
    return 1;
  }
  if (!json) console.log('inspect-arch passed.');
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
