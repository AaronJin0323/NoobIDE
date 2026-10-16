#!/usr/bin/env node
// S28.1: generates the app icon files in resources/icons/ from the NoobIDE logo: a brand-blue rounded square with a
// white "< • >" mark, an HTML tag holding one dot (the vector original is resources/brand/noobide-logo.svg; keep the
// geometry below in step with it). Pure Node (zlib only): no image tools, no native modules.
//
//   node scripts/make-icons.mjs        # writes icon.png (1024), icon.icns (macOS), icon.ico (Windows)
//
// The output is deterministic, so re-running produces byte-identical files. To replace the artwork, overwrite the
// three files with the same names and sizes.
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'resources', 'icons');

const BACKGROUND = [29, 108, 240]; // #1D6CF0, the theme accent (src/renderer/theme/tokens.ts)
const FOREGROUND = [255, 255, 255];

// Geometry in a 1024 unit square. macOS-style margin: the tile covers 824 units, centred.
const TILE = { x0: 100, y0: 100, x1: 924, y1: 924, radius: 185 };
const STROKE = 44; // half-width of the chevron strokes (round caps and joins)
const SEGMENTS = [
  // "<"
  [
    [356, 352],
    [216, 512],
  ],
  [
    [216, 512],
    [356, 672],
  ],
  // ">"
  [
    [668, 352],
    [808, 512],
  ],
  [
    [808, 512],
    [668, 672],
  ],
];
const DOT = { x: 512, y: 512, r: 64 };

function roundedRectDistance(x, y) {
  const cx = (TILE.x0 + TILE.x1) / 2;
  const cy = (TILE.y0 + TILE.y1) / 2;
  const hx = (TILE.x1 - TILE.x0) / 2 - TILE.radius;
  const hy = (TILE.y1 - TILE.y0) / 2 - TILE.radius;
  const qx = Math.abs(x - cx) - hx;
  const qy = Math.abs(y - cy) - hy;
  const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0));
  return outside + Math.min(Math.max(qx, qy), 0) - TILE.radius;
}

function segmentDistance(x, y, [[ax, ay], [bx, by]]) {
  const px = x - ax;
  const py = y - ay;
  const dx = bx - ax;
  const dy = by - ay;
  const t = Math.max(0, Math.min(1, (px * dx + py * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - t * dx, py - t * dy) - STROKE;
}

/** Renders the icon at `size` px as RGBA, anti-aliased by signed distance (one pixel of smoothing). */
export function renderIcon(size) {
  const scale = 1024 / size;
  const rgba = Buffer.alloc(size * size * 4);
  for (let py = 0; py < size; py += 1) {
    for (let px = 0; px < size; px += 1) {
      const x = (px + 0.5) * scale;
      const y = (py + 0.5) * scale;
      const tile = Math.min(1, Math.max(0, 0.5 - roundedRectDistance(x, y) / scale));
      const glyphDistance = Math.min(
        Math.hypot(x - DOT.x, y - DOT.y) - DOT.r,
        ...SEGMENTS.map((s) => segmentDistance(x, y, s)),
      );
      const glyph = Math.min(1, Math.max(0, 0.5 - glyphDistance / scale));
      const i = (py * size + px) * 4;
      for (let c = 0; c < 3; c += 1) {
        rgba[i + c] = Math.round(BACKGROUND[c] * (1 - glyph) + FOREGROUND[c] * glyph);
      }
      rgba[i + 3] = Math.round(255 * tile);
    }
  }
  return rgba;
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

export function encodePng(size, rgba) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // RGBA
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y += 1) rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const pngCache = new Map();
function png(size) {
  if (!pngCache.has(size)) pngCache.set(size, encodePng(size, renderIcon(size)));
  return pngCache.get(size);
}

/** Apple icon image: PNG-payload entries (supported since macOS 10.7). */
export const ICNS_TYPES = [
  ['icp4', 16],
  ['icp5', 32],
  ['icp6', 64],
  ['ic07', 128],
  ['ic08', 256],
  ['ic09', 512],
  ['ic10', 1024],
  ['ic11', 32],
  ['ic12', 64],
  ['ic13', 256],
  ['ic14', 512],
];

export function encodeIcns() {
  const entries = ICNS_TYPES.map(([type, size]) => {
    const data = png(size);
    const head = Buffer.alloc(8);
    head.write(type, 0, 'ascii');
    head.writeUInt32BE(data.length + 8, 4);
    return Buffer.concat([head, data]);
  });
  const body = Buffer.concat(entries);
  const head = Buffer.alloc(8);
  head.write('icns', 0, 'ascii');
  head.writeUInt32BE(body.length + 8, 4);
  return Buffer.concat([head, body]);
}

/** Windows icon: PNG-payload entries (supported since Windows Vista). */
export const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];

export function encodeIco() {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(ICO_SIZES.length, 4);
  const directory = Buffer.alloc(16 * ICO_SIZES.length);
  const images = [];
  let offset = header.length + directory.length;
  ICO_SIZES.forEach((size, i) => {
    const data = png(size);
    const at = i * 16;
    directory[at] = size >= 256 ? 0 : size;
    directory[at + 1] = size >= 256 ? 0 : size;
    directory.writeUInt16LE(1, at + 4); // colour planes
    directory.writeUInt16LE(32, at + 6); // bits per pixel
    directory.writeUInt32LE(data.length, at + 8);
    directory.writeUInt32LE(offset, at + 12);
    offset += data.length;
    images.push(data);
  });
  return Buffer.concat([header, directory, ...images]);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  mkdirSync(outDir, { recursive: true });
  writeFileSync(path.join(outDir, 'icon.png'), png(1024));
  writeFileSync(path.join(outDir, 'icon.icns'), encodeIcns());
  writeFileSync(path.join(outDir, 'icon.ico'), encodeIco());
  console.log(`icons written to ${path.relative(root, outDir)}: icon.png, icon.icns, icon.ico`);
}
