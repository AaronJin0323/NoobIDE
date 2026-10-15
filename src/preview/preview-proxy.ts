import { createServer, connect as netConnect, isIP, type Server, type Socket } from 'node:net';
import type { AddressInfo } from 'node:net';
import { embeddedIpv4, inNetwork, isPublicAddress, normalizeIp } from './address-policy';

/**
 * The preview session's only way onto the network (S05.5, docs/decisions/0015): a SOCKS5 proxy on 127.0.0.1 that
 * the preview session is configured to use for every request, loopback included (`<-loopback>`).
 *
 * Why a proxy: Chromium resolves host names itself, so a policy that looks at the URL cannot know that
 * `localtest.me`, a LAN name or a DNS-rebinding name points at this machine or the local network. With SOCKS5,
 * Chromium hands the host name to the proxy; the proxy resolves it, checks every address, and connects to exactly
 * the address it checked — there is no second lookup an attacker could rebind.
 *
 * Allowed: the project's static server (only the literal `127.0.0.1:<port>`), and public internet addresses.
 * Everything else — other loopback ports, private, link-local, CGNAT, this machine's own interface addresses — gets
 * SOCKS reply 0x02 "not allowed by ruleset", which the page sees as a failed request.
 *
 * Resolution is injected (production: Chromium's resolver via `session.resolveHost`, which runs in the network
 * service and never occupies Node's libuv threadpool that file I/O depends on). It is still capped (concurrency,
 * queue, timeout) so a page cannot pile up unbounded work in main.
 *
 * The proxy never logs; blocked targets are reported through `onBlocked` as host + port only.
 */

export interface PreviewProxyOptions {
  /** The project's static server: the only loopback destination allowed. */
  readonly serverHost: string;
  readonly serverPort: number;
  /** Resolves a host name to IP addresses. */
  resolve(host: string): Promise<readonly string[]>;
  /** Addresses of this machine's interfaces (refused even when public). */
  localAddresses?(): readonly string[];
  /** Networks this machine is attached to, as CIDR (refused even when public: IPv6 LANs use global addresses). */
  localNetworks?(): readonly string[];
  onBlocked?(target: { readonly host: string; readonly port: number }): void;
  /** Test hook: how to open the upstream connection to a checked address. */
  readonly connect?: ((ip: string, port: number) => Socket) | undefined;
  readonly maxConnections?: number;
  readonly maxConcurrentResolves?: number;
  readonly maxQueuedResolves?: number;
  readonly resolveTimeoutMs?: number;
  readonly handshakeTimeoutMs?: number;
  readonly connectTimeoutMs?: number;
}

/** SOCKS5 reply codes (RFC 1928 §6). */
const REP = { ok: 0, failure: 1, notAllowed: 2, hostUnreachable: 4, refused: 5, commandNotSupported: 7 } as const;

export type ProxyDecision = { readonly allow: true; readonly ip: string } | { readonly allow: false };

export class PreviewProxy {
  private readonly sockets = new Set<Socket>();
  private readonly limiter: ConcurrencyLimiter;

  private constructor(
    private readonly server: Server,
    private readonly options: PreviewProxyOptions,
    readonly port: number,
  ) {
    this.limiter = new ConcurrencyLimiter(options.maxConcurrentResolves ?? 4, options.maxQueuedResolves ?? 64);
  }

  /** Chromium proxy rules for `session.setProxy`. */
  get proxyRules(): string {
    return `socks5://127.0.0.1:${this.port}`;
  }

  static async start(options: PreviewProxyOptions): Promise<PreviewProxy> {
    let proxy: PreviewProxy | null = null;
    const server = createServer((socket) => {
      if (proxy) proxy.accept(socket);
      else socket.destroy();
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen({ host: '127.0.0.1', port: 0, exclusive: true }, () => {
        server.off('error', reject);
        // Accept failures (EMFILE…) are emitted on the server; without a listener they would crash main.
        server.on('error', () => undefined);
        resolve();
      });
    });
    proxy = new PreviewProxy(server, options, (server.address() as AddressInfo).port);
    return proxy;
  }

  async close(): Promise<void> {
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  /** Where a CONNECT to `host:port` may go: the checked address to connect to, or a refusal. */
  async decide(host: string, port: number): Promise<ProxyDecision> {
    const literal = normalizeIp(host);
    if (literal !== null) {
      if (literal === normalizeIp(this.options.serverHost) && port === this.options.serverPort) {
        return { allow: true, ip: literal };
      }
      return this.isAllowedAddress(literal) ? { allow: true, ip: literal } : { allow: false };
    }
    const name = host.toLowerCase().replace(/\.+$/, '');
    if (name === '' || name === 'localhost' || name.endsWith('.localhost')) return { allow: false };
    let addresses: readonly string[];
    try {
      addresses = await this.limiter.run(() => this.options.resolve(name), this.options.resolveTimeoutMs ?? 5_000);
    } catch {
      return { allow: false };
    }
    const ips = addresses.map((a) => normalizeIp(a)).filter((a): a is string => a !== null);
    // Every address must be public: a name that also resolves to a local address is refused as a whole.
    if (ips.length === 0 || ips.length !== addresses.length || !ips.every((ip) => this.isAllowedAddress(ip))) {
      return { allow: false };
    }
    return { allow: true, ip: ips[0] ?? '' };
  }

  private isAllowedAddress(ip: string): boolean {
    if (!isPublicAddress(ip)) return false;
    // Judge IPv4-mapped / NAT64 / 6to4 forms by the IPv4 address they reach as well.
    const forms = [ip, embeddedIpv4(ip)].filter((f): f is string => f !== null);
    const own = new Set((this.options.localAddresses?.() ?? []).map((a) => normalizeIp(a)));
    if (forms.some((f) => own.has(normalizeIp(f)))) return false;
    const networks = this.options.localNetworks?.() ?? [];
    return !forms.some((f) => networks.some((net) => inNetwork(f, net)));
  }

  private accept(socket: Socket): void {
    if (this.sockets.size >= (this.options.maxConnections ?? 256)) {
      socket.destroy();
      return;
    }
    this.track(socket);
    socket.setNoDelay(true);
    let buffer = Buffer.alloc(0);
    let stage: 'greeting' | 'request' | 'busy' = 'greeting';
    const timer = setTimeout(() => socket.destroy(), this.options.handshakeTimeoutMs ?? 10_000);
    socket.once('close', () => clearTimeout(timer));

    const onData = (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length > 1024) {
        socket.destroy(); // no valid handshake is this long
        return;
      }
      if (stage === 'greeting') {
        if (buffer.length < 2) return;
        if (buffer[0] !== 5) {
          socket.destroy();
          return;
        }
        const methods = buffer[1] ?? 0;
        if (buffer.length < 2 + methods) return;
        const offered = buffer.subarray(2, 2 + methods);
        buffer = buffer.subarray(2 + methods);
        if (!offered.includes(0)) {
          socket.end(Buffer.from([5, 0xff]));
          return;
        }
        socket.write(Buffer.from([5, 0]));
        stage = 'request';
      }
      if (stage === 'request') {
        const request = parseRequest(buffer);
        if (request === 'incomplete') return;
        if (request === 'invalid') {
          socket.destroy();
          return;
        }
        stage = 'busy';
        socket.off('data', onData);
        socket.pause();
        clearTimeout(timer);
        const rest = buffer.subarray(request.length);
        if (request.command !== 1) {
          reply(socket, REP.commandNotSupported, true);
          return;
        }
        void this.open(socket, request.host, request.port, rest);
      }
    };
    socket.on('data', onData);
  }

  private async open(client: Socket, host: string, port: number, rest: Buffer): Promise<void> {
    const decision = await this.decide(host, port);
    if (client.destroyed) return;
    if (!decision.allow) {
      this.options.onBlocked?.({ host: host.slice(0, 255), port });
      reply(client, REP.notAllowed, true);
      return;
    }
    const upstream = this.options.connect?.(decision.ip, port) ?? netConnect({ host: decision.ip, port });
    this.track(upstream);
    const connectTimer = setTimeout(() => upstream.destroy(), this.options.connectTimeoutMs ?? 15_000);
    let connected = false;
    upstream.once('connect', () => {
      connected = true;
      clearTimeout(connectTimer);
      if (client.destroyed) {
        upstream.destroy();
        return;
      }
      upstream.setNoDelay(true);
      reply(client, REP.ok, false);
      if (rest.length > 0) upstream.write(rest);
      client.pipe(upstream);
      upstream.pipe(client);
      client.resume();
    });
    upstream.once('error', (error: NodeJS.ErrnoException) => {
      clearTimeout(connectTimer);
      if (!connected && !client.destroyed && !client.writableEnded) {
        reply(client, error.code === 'ECONNREFUSED' ? REP.refused : REP.hostUnreachable, true);
      }
    });
    upstream.once('close', () => {
      clearTimeout(connectTimer);
      if (!client.destroyed) client.end();
    });
    client.once('close', () => upstream.destroy());
  }

  private track(socket: Socket): void {
    this.sockets.add(socket);
    socket.on('error', () => socket.destroy());
    socket.once('close', () => this.sockets.delete(socket));
  }
}

interface SocksRequest {
  readonly command: number;
  readonly host: string;
  readonly port: number;
  /** Bytes the request occupied. */
  readonly length: number;
}

/** Parses a SOCKS5 request header: VER CMD RSV ATYP DST.ADDR DST.PORT. */
export function parseRequest(buffer: Buffer): SocksRequest | 'incomplete' | 'invalid' {
  if (buffer.length < 5) return 'incomplete';
  if (buffer[0] !== 5 || buffer[2] !== 0) return 'invalid';
  const command = buffer[1] ?? 0;
  const atyp = buffer[3];
  let host: string;
  let offset: number;
  if (atyp === 1) {
    if (buffer.length < 10) return 'incomplete';
    host = [...buffer.subarray(4, 8)].join('.');
    offset = 8;
  } else if (atyp === 3) {
    const len = buffer[4] ?? 0;
    if (len === 0) return 'invalid';
    if (buffer.length < 5 + len + 2) return 'incomplete';
    host = buffer.subarray(5, 5 + len).toString('latin1');
    // Host names come from Chromium already in ASCII (punycode); anything else is not a host name.
    if (!/^[\w.-]+$/.test(host) && isIP(host.replace(/^\[|\]$/g, '')) === 0) return 'invalid';
    offset = 5 + len;
  } else if (atyp === 4) {
    if (buffer.length < 22) return 'incomplete';
    const groups: string[] = [];
    for (let i = 0; i < 16; i += 2) groups.push(buffer.readUInt16BE(4 + i).toString(16));
    host = groups.join(':');
    offset = 20;
  } else {
    return 'invalid';
  }
  const port = buffer.readUInt16BE(offset);
  return { command, host, port, length: offset + 2 };
}

function reply(socket: Socket, code: number, close: boolean): void {
  const message = Buffer.from([5, code, 0, 1, 0, 0, 0, 0, 0, 0]);
  if (close) socket.end(message);
  else socket.write(message);
}

/** Runs at most `max` tasks at once; a slot stays taken until its task settles, even after a timeout. */
export class ConcurrencyLimiter {
  private active = 0;
  private readonly queue: (() => void)[] = [];

  constructor(
    private readonly max: number,
    private readonly maxQueued: number,
  ) {}

  run<T>(task: () => Promise<T>, timeoutMs: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        settled = true;
        reject(new Error('timeout'));
      }, timeoutMs);
      const start = () => {
        if (settled) {
          this.queue.shift()?.(); // timed out while queued: never started
          return;
        }
        this.active += 1;
        let result: Promise<T>;
        try {
          result = task();
        } catch (e) {
          result = Promise.reject(e instanceof Error ? e : new Error('task failed'));
        }
        result
          .then(
            (value) => {
              if (!settled) resolve(value);
            },
            (error: unknown) => {
              if (!settled) reject(error instanceof Error ? error : new Error('task failed'));
            },
          )
          .finally(() => {
            settled = true;
            clearTimeout(timer);
            this.active -= 1;
            this.queue.shift()?.();
          });
      };
      if (this.active < this.max) start();
      else if (this.queue.length < this.maxQueued) this.queue.push(start);
      else {
        clearTimeout(timer);
        reject(new Error('busy'));
      }
    });
  }
}
