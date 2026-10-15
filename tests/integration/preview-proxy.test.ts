import { createServer, connect, type Server, type Socket } from 'node:net';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ConcurrencyLimiter,
  parseRequest,
  PreviewProxy,
  type PreviewProxyOptions,
} from '../../src/preview/preview-proxy';

/**
 * S05.5 / decision 0015: the preview's SOCKS5 proxy decides on resolved addresses and connects to exactly the
 * address it checked. Resolution is injected, so a "DNS rebinding" name can be simulated without a DNS server, and
 * the upstream connect is redirected to a local echo server to stand in for a public host.
 */

let echo: Server;
let echoPort: number;
let proxy: PreviewProxy | null = null;
const blocked: string[] = [];

beforeEach(async () => {
  blocked.length = 0;
  echo = createServer((socket) => {
    socket.on('error', () => undefined);
    socket.on('data', (d) => socket.write(Buffer.concat([Buffer.from('echo:'), d])));
  });
  await new Promise<void>((resolve) => echo.listen(0, '127.0.0.1', resolve));
  echoPort = (echo.address() as AddressInfo).port;
});

afterEach(async () => {
  await proxy?.close();
  proxy = null;
  await new Promise<void>((resolve) => echo.close(() => resolve()));
});

async function startProxy(overrides: Partial<PreviewProxyOptions> = {}): Promise<PreviewProxy> {
  const connected: string[] = [];
  proxy = await PreviewProxy.start({
    serverHost: '127.0.0.1',
    serverPort: echoPort,
    resolve: async (host) => {
      const table: Record<string, string[]> = {
        'public.test': ['93.184.216.34'],
        'rebind.test': ['127.0.0.1'],
        'lan.test': ['192.168.1.20'],
        'mixed.test': ['93.184.216.34', '10.0.0.5'],
        'v6local.test': ['::1'],
      };
      const found = table[host];
      if (!found) throw new Error('ENOTFOUND');
      return found;
    },
    localAddresses: () => ['127.0.0.1', '::1', '203.0.113.250', '81.2.69.160'],
    onBlocked: ({ host, port }) => blocked.push(`${host}:${port}`),
    // A checked public address is redirected to the local echo server, recording which address was used.
    connect: (ip, port) => {
      connected.push(`${ip}:${port}`);
      return connect({ host: '127.0.0.1', port: echoPort });
    },
    ...overrides,
  });
  (proxy as unknown as { connected: string[] }).connected = connected;
  return proxy;
}

type Target = { domain: string } | { ipv4: number[] } | { ipv6: number[] };

/** Minimal SOCKS5 client: returns the reply code and, when 0, the open socket. */
async function socks(port: number, target: Target, targetPort: number): Promise<{ code: number; socket: Socket }> {
  const socket = connect({ host: '127.0.0.1', port });
  socket.on('error', () => undefined);
  await new Promise<void>((resolve) => socket.once('connect', () => resolve()));
  const read = (n: number) =>
    new Promise<Buffer>((resolve, reject) => {
      let buf = Buffer.alloc(0);
      const onData = (d: Buffer) => {
        buf = Buffer.concat([buf, d]);
        if (buf.length >= n) {
          socket.off('data', onData);
          socket.off('close', onClose);
          resolve(buf);
        }
      };
      const onClose = () => reject(new Error(`closed after ${buf.length} bytes`));
      socket.on('data', onData);
      socket.once('close', onClose);
    });
  socket.write(Buffer.from([5, 1, 0]));
  expect([...(await read(2))]).toEqual([5, 0]);
  let addr: Buffer;
  if ('domain' in target) addr = Buffer.concat([Buffer.from([3, target.domain.length]), Buffer.from(target.domain)]);
  else if ('ipv4' in target) addr = Buffer.from([1, ...target.ipv4]);
  else addr = Buffer.from([4, ...target.ipv6]);
  const portBuf = Buffer.alloc(2);
  portBuf.writeUInt16BE(targetPort);
  socket.write(Buffer.concat([Buffer.from([5, 1, 0]), addr, portBuf]));
  const replyBuf = await read(10);
  return { code: replyBuf[1] ?? -1, socket };
}

async function roundTrip(socket: Socket): Promise<string> {
  const answer = new Promise<string>((resolve) => socket.once('data', (d) => resolve(d.toString())));
  socket.write('ping');
  return answer;
}

describe('preview network proxy (S05.5)', () => {
  it('connects a public name to the address it checked and relays data', async () => {
    const p = await startProxy();
    const { code, socket } = await socks(p.port, { domain: 'public.test' }, 443);
    expect(code).toBe(0);
    expect(await roundTrip(socket)).toBe('echo:ping');
    expect((p as unknown as { connected: string[] }).connected).toEqual(['93.184.216.34:443']);
    socket.destroy();
  });

  it('allows the project server only as the literal 127.0.0.1:<port>', async () => {
    const p = await startProxy({ connect: undefined });
    const { code, socket } = await socks(p.port, { ipv4: [127, 0, 0, 1] }, echoPort);
    expect(code).toBe(0);
    expect(await roundTrip(socket)).toBe('echo:ping');
    socket.destroy();
    // Same address, any other port: refused.
    expect((await socks(p.port, { ipv4: [127, 0, 0, 1] }, echoPort + 1)).code).toBe(2);
    // The server's port under a name that resolves to loopback: refused (no Host-header games either).
    expect((await socks(p.port, { domain: 'rebind.test' }, echoPort)).code).toBe(2);
    expect((await socks(p.port, { domain: 'localhost' }, echoPort)).code).toBe(2);
  });

  it.each([
    ['a name resolving to loopback (DNS rebinding, localtest.me)', { domain: 'rebind.test' }],
    ['a name resolving to the LAN', { domain: 'lan.test' }],
    ['a name with one public and one private address', { domain: 'mixed.test' }],
    ['a name resolving to IPv6 loopback', { domain: 'v6local.test' }],
    ['localhost', { domain: 'localhost' }],
    ['a *.localhost name', { domain: 'app.localhost' }],
    ['a name that does not resolve', { domain: 'missing.test' }],
    ['a LAN IP literal sent as a name', { domain: '192.168.1.20' }],
    ['a LAN IPv4 literal', { ipv4: [192, 168, 1, 20] }],
    ['a link-local IPv4 literal (cloud metadata)', { ipv4: [169, 254, 169, 254] }],
    ['another loopback address', { ipv4: [127, 0, 0, 2] }],
    ['0.0.0.0', { ipv4: [0, 0, 0, 0] }],
    ['IPv6 loopback', { ipv6: [...Array<number>(15).fill(0), 1] }],
    ['IPv4-mapped loopback', { ipv6: [...Array<number>(10).fill(0), 0xff, 0xff, 127, 0, 0, 1] }],
    ["this machine's public interface address", { ipv4: [81, 2, 69, 160] }],
  ] as [string, Target][])('refuses %s', async (_name, target) => {
    const p = await startProxy();
    const { code } = await socks(p.port, target, 8080);
    expect(code).toBe(2);
    expect((p as unknown as { connected: string[] }).connected).toEqual([]);
    expect(blocked).toHaveLength(1);
  });

  it('refuses commands other than CONNECT and drops non-SOCKS clients (a browser cannot use it)', async () => {
    const p = await startProxy();
    const socket = connect({ host: '127.0.0.1', port: p.port });
    socket.on('error', () => undefined);
    const closed = new Promise<string>((resolve) => {
      let got = '';
      socket.on('data', (d) => (got += d.toString()));
      socket.once('close', () => resolve(got));
    });
    socket.write('GET / HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n');
    expect(await closed).toBe('');

    const udp = connect({ host: '127.0.0.1', port: p.port });
    udp.on('error', () => undefined);
    const replies: Buffer[] = [];
    udp.on('data', (d) => replies.push(d));
    await new Promise<void>((resolve) => udp.once('connect', () => resolve()));
    udp.write(Buffer.from([5, 1, 0]));
    udp.write(Buffer.from([5, 3, 0, 1, 93, 184, 216, 34, 0, 53])); // UDP ASSOCIATE
    await new Promise<void>((resolve) => udp.once('close', () => resolve()));
    expect(Buffer.concat(replies)[3]).toBe(7);
  });

  it('closes every relayed connection when the preview stops', async () => {
    const p = await startProxy();
    const { socket } = await socks(p.port, { domain: 'public.test' }, 443);
    const closed = new Promise<void>((resolve) => socket.once('close', () => resolve()));
    await p.close();
    proxy = null;
    await closed;
  });
});

describe('SOCKS5 request parsing', () => {
  it('waits for complete requests and rejects malformed ones', () => {
    expect(parseRequest(Buffer.from([5, 1, 0, 3, 4, 0x61]))).toBe('incomplete');
    expect(parseRequest(Buffer.from([5, 1, 0, 3, 0, 0, 80]))).toBe('invalid');
    expect(parseRequest(Buffer.from([4, 1, 0, 1, 1, 2, 3, 4, 0, 80]))).toBe('invalid');
    expect(parseRequest(Buffer.from([5, 1, 0, 9, 1, 2, 3, 4, 0, 80]))).toBe('invalid');
    expect(
      parseRequest(Buffer.concat([Buffer.from([5, 1, 0, 3, 5]), Buffer.from('a/b c'), Buffer.from([0, 80])])),
    ).toBe('invalid');
    expect(parseRequest(Buffer.from([5, 1, 0, 1, 1, 2, 3, 4, 0x1f, 0x90]))).toEqual({
      command: 1,
      host: '1.2.3.4',
      port: 8080,
      length: 10,
    });
  });
});

describe('resolution limiter', () => {
  it('runs at most N lookups at once, keeps a slot until a timed-out lookup settles, and refuses a full queue', async () => {
    const limiter = new ConcurrencyLimiter(2, 1);
    let running = 0;
    let peak = 0;
    const releases: (() => void)[] = [];
    const task = () =>
      new Promise<string>((resolve) => {
        running += 1;
        peak = Math.max(peak, running);
        releases.push(() => {
          running -= 1;
          resolve('ok');
        });
      });
    const a = limiter.run(task, 20);
    const b = limiter.run(task, 10_000);
    const c = limiter.run(task, 10_000); // queued
    const d = limiter.run(task, 10_000); // queue full
    await expect(d).rejects.toThrow('busy');
    await expect(a).rejects.toThrow('timeout');
    // a timed out but is still running: c must not have started.
    expect(running).toBe(2);
    releases.shift()?.(); // a settles → c starts
    await new Promise((r) => setTimeout(r, 0));
    expect(running).toBe(2);
    releases.shift()?.();
    releases.shift()?.();
    await expect(b).resolves.toBe('ok');
    await expect(c).resolves.toBe('ok');
    expect(peak).toBe(2);
  });
});
