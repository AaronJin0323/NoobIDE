import { isIP } from 'node:net';

/**
 * Which resolved IP addresses a preview page may connect to (S05.5, docs/decisions/0015). Pure functions.
 *
 * The page may use the public internet (a CDN, an image host — PLAN §8 keeps normal browser network behaviour), but
 * nothing on this machine or the local network: loopback, unspecified, private (RFC 1918), carrier-grade NAT
 * (often VPNs such as Tailscale), link-local, unique-local IPv6, multicast, broadcast, documentation and reserved
 * ranges, plus IPv6 forms that embed an IPv4 address (mapped, NAT64, 6to4) are judged by that IPv4 address; Teredo
 * and IPv4-compatible forms are refused. The decision is made on the address the proxy actually connects to, never on a hostname.
 */

/** IPv4 ranges that are not the public internet: [network, prefix length]. */
const NON_PUBLIC_V4: readonly (readonly [number, number])[] = [
  [v4(0, 0, 0, 0), 8], // "this network", 0.0.0.0
  [v4(10, 0, 0, 0), 8], // private
  [v4(100, 64, 0, 0), 10], // carrier-grade NAT / VPN overlays
  [v4(127, 0, 0, 0), 8], // loopback
  [v4(169, 254, 0, 0), 16], // link-local
  [v4(172, 16, 0, 0), 12], // private
  [v4(192, 0, 0, 0), 24], // IETF protocol assignments
  [v4(192, 0, 2, 0), 24], // documentation
  [v4(192, 88, 99, 0), 24], // 6to4 relay anycast (deprecated)
  [v4(192, 168, 0, 0), 16], // private
  [v4(198, 18, 0, 0), 15], // benchmarking
  [v4(198, 51, 100, 0), 24], // documentation
  [v4(203, 0, 113, 0), 24], // documentation
  [v4(224, 0, 0, 0), 4], // multicast
  [v4(240, 0, 0, 0), 4], // reserved, includes 255.255.255.255 broadcast
];

function v4(a: number, b: number, c: number, d: number): number {
  return ((a << 24) | (b << 16) | (c << 8) | d) >>> 0;
}

function parseV4(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number(part);
    if (n > 255) return null;
    value = value * 256 + n;
  }
  return value >>> 0;
}

function isPublicV4(value: number): boolean {
  return !NON_PUBLIC_V4.some(([net, bits]) => {
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    return (value & mask) >>> 0 === net;
  });
}

/** Eight 16-bit groups of an IPv6 address (an embedded dotted IPv4 tail is accepted), or null. */
function parseV6(input: string): number[] | null {
  let ip = input.replace(/^\[|\]$/g, '');
  const zone = ip.indexOf('%');
  if (zone >= 0) ip = ip.slice(0, zone); // fe80::1%en0 — the zone does not change the range
  let tail: number[] = [];
  const lastColon = ip.lastIndexOf(':');
  if (ip.includes('.', lastColon)) {
    const v4value = parseV4(ip.slice(lastColon + 1));
    if (v4value === null) return null;
    tail = [v4value >>> 16, v4value & 0xffff];
    ip = `${ip.slice(0, lastColon + 1)}0:0`;
  }
  const halves = ip.split('::');
  if (halves.length > 2) return null;
  const groups = (s: string) => (s === '' ? [] : s.split(':'));
  const head = groups(halves[0] ?? '');
  const rest = halves.length === 2 ? groups(halves[1] ?? '') : [];
  const missing = 8 - head.length - rest.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
  const all = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill('0'), ...rest];
  const out: number[] = [];
  for (const g of all) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
    out.push(parseInt(g, 16));
  }
  if (tail.length === 2) {
    out[6] = tail[0] ?? 0;
    out[7] = tail[1] ?? 0;
  }
  return out;
}

function isPublicV6(g: number[]): boolean {
  const [a = 0, b = 0, c = 0, d = 0, e = 0, f = 0, h = 0, i = 0] = g;
  const embedded = (hi: number, lo: number) => isPublicV4(((hi << 16) | lo) >>> 0);
  if (a === 0 && b === 0 && c === 0 && d === 0 && e === 0) {
    if (f === 0xffff) return embedded(h, i); // ::ffff:a.b.c.d (mapped)
    if (f === 0) return false; // ::, ::1 and the deprecated IPv4-compatible ::a.b.c.d — never needed by a page
  }
  if (a === 0x64 && b === 0xff9b) return embedded(h, i); // NAT64 64:ff9b::/96 (and the local-use /48)
  if (a === 0x2002) return embedded(b, c); // 6to4
  if (a === 0x2001 && b === 0) return false; // Teredo tunnels can end on this machine
  if ((a & 0xfe00) === 0xfc00) return false; // unique local fc00::/7
  if ((a & 0xffc0) === 0xfe80) return false; // link-local fe80::/10
  if ((a & 0xffc0) === 0xfec0) return false; // site-local (deprecated) fec0::/10
  if ((a & 0xff00) === 0xff00) return false; // multicast
  if (a === 0x2001 && b === 0xdb8) return false; // documentation
  if (a === 0x100 && b === 0 && c === 0 && d === 0) return false; // discard-only 100::/64
  // Only global unicast 2000::/3 is routable on the internet.
  return (a & 0xe000) === 0x2000;
}

/** True only for an address on the public internet. Anything unparsable counts as not public. */
export function isPublicAddress(ip: string): boolean {
  const family = isIP(ip.replace(/^\[|\]$/g, '').replace(/%.*$/, ''));
  if (family === 4) {
    const value = parseV4(ip);
    return value !== null && isPublicV4(value);
  }
  if (family === 6) {
    const groups = parseV6(ip);
    return groups !== null && isPublicV6(groups);
  }
  return false;
}

/** Canonical text of an IP literal for comparisons (lower case, no brackets or zone), or null if not an IP. */
export function normalizeIp(ip: string): string | null {
  const bare = ip.replace(/^\[|\]$/g, '').replace(/%.*$/, '');
  const family = isIP(bare);
  if (family === 4) return bare;
  if (family === 6) {
    const groups = parseV6(bare);
    return groups ? groups.map((g) => g.toString(16)).join(':') : null;
  }
  return null;
}
