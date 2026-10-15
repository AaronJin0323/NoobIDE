# 0015 — Preview network policy: decide on resolved addresses through a SOCKS5 proxy

- **Status:** accepted
- **Date:** 2026-10-15
- **Feature:** S05.5 (reopened after the preview security review); amends 0009

## Context

Decision 0009 blocked loopback _host names_ (`localhost`, `127/8`, `[::1]`, …) in `webRequest.onBeforeRequest`. The
security review showed that a page still reached other services on this machine and on the LAN:

- through any DNS name that resolves to a local address — public ones such as `localtest.me` / `*.nip.io`, the
  machine's own name, a LAN name, or a DNS-rebinding name that answers public first and loopback later;
- through the machine's LAN IP address (a dev server, database UI, printer or router admin page bound to `0.0.0.0`).

`onBeforeRequest` only sees the URL. Chromium resolves the name later, in the network service, so a check there can
neither see the address nor stop a second lookup from answering differently (DNS rebinding). The review also listed:
JavaScript dialogs that disable the IDE, `beforeunload` blocking refresh/close, unsanitised URLs in records, and
service workers that persist across sessions.

PLAN §8 keeps "normal browser same-origin and network checks" and §11 (offline row) lets the page request external
resources (a CDN), so the public internet must stay reachable; only this machine and private networks are off limits.

## Options considered

1. **Resolve in `onBeforeRequest`** (`session.resolveHost` or `dns.lookup`) and cancel if local. Leaves a
   time-of-check/time-of-use gap: Chromium resolves again before connecting (rebinding with TTL 0), and request
   types that `webRequest` does not see (WebTransport, WebRTC) are not covered. `dns.lookup` would also occupy
   Node's 4-thread libuv pool that file saves depend on.
2. **Check the connected IP afterwards** (`details.ip` in `onResponseStarted`). Too late: the request (a `POST` to a
   local admin page) has already been sent.
3. **`--host-resolver-rules` / Chromium flags.** App-wide, cannot express "any name that resolves to a private
   address", and would affect the workbench.
4. **A proxy owned by main that resolves, checks and connects to exactly the checked address (chosen).** SOCKS5,
   because Chromium hands it the host name (remote resolution) and tunnels http, https, ws and wss the same way, so
   one small TCP relay covers everything; an HTTP proxy would need request parsing for plain http.

## Decision

- `src/preview/preview-proxy.ts`: a SOCKS5 server on `127.0.0.1:<random>` per live preview (closed with it).
  For every CONNECT it decides on the address, never the name:
  - the project's static server is allowed only as the literal `127.0.0.1:<server port>`;
  - an IP literal must be public (below), not one of this machine's interface addresses and not inside a network
    this machine is attached to (`os.networkInterfaces` addresses and CIDRs — on IPv6 networks, and on LANs with
    public IPv4 addresses, the other devices have "public" addresses). IPv4-mapped, NAT64 and 6to4 forms are also
    checked by their embedded IPv4 address;
  - a name (`localhost` and `*.localhost` are refused without lookup) is resolved; **every** returned address must be
    allowed, and the proxy connects to the first one itself. No second resolution exists, so rebinding cannot
    redirect the connection.
  - refused → SOCKS reply 0x02; the page sees a failed request (and a network record), `blockedRequests` gets
    `{ scheme: 'proxy', host: '<host>:<port>' }` — never paths or contents. Only CONNECT is supported (no UDP
    ASSOCIATE / BIND); clients that do not speak SOCKS5 are dropped, so a browser tab cannot use it as an HTTP proxy.
- `src/preview/address-policy.ts` (pure, unit-tested): public = not in 0/8, 10/8, 100.64/10 (CGNAT, VPN overlays),
  127/8, 169.254/16 (incl. cloud metadata), 172.16/12, 192.0.0/24, 192.0.2/24, 192.88.99/24, 192.168/16, 198.18/15,
  198.51.100/24, 203.0.113/24, 224/4, 240/4; IPv6 only global unicast 2000::/3 minus documentation and Teredo;
  IPv4-mapped, NAT64 and 6to4 addresses are judged by their embedded IPv4 address.
- Resolution uses Chromium's resolver through `session.resolveHost` — the same answers (hosts file, DNS-over-HTTPS
  settings, `--host-resolver-rules`) the page would get, executed in the network service, so it never takes a libuv
  threadpool thread from file I/O. It is still capped: at most 4 lookups at once, 64 queued (more → refused), 5 s
  timeout, and a slot stays taken until a timed-out lookup really settles.
- The preview session uses it for **everything**: `setProxy({ mode: 'fixed_servers', proxyRules:
'socks5://127.0.0.1:<port>', proxyBypassRules: '<-loopback>' })`. `<-loopback>` removes Chromium's implicit
  loopback bypass, so even requests to the project server go through the proxy and nothing (including WebTransport,
  which `webRequest` does not see and which is never proxied) can reach a loopback port directly. WebRTC is limited
  with `setWebRTCIPHandlingPolicy('disable_non_proxied_udp')`.
- The `onBeforeRequest` policy (0009) stays as the first layer: schemes (`file:`, custom), loopback names, other
  ports. The static server's Host and token checks stay as the last layer.
- **Dialogs:** `webPreferences.disableDialogs: true` (asserted like the other required preferences): `alert` returns
  at once, `confirm` returns false, `prompt` is unsupported in Electron (throws), so no modal dialog can disable the
  IDE. The page guard (0016) reports `alert(text)` in the console and makes `print()` a no-op. With the DevTools
  Page domain enabled (0016), `Page.javascriptDialogOpening` is answered immediately as well.
- **beforeunload:** `will-prevent-unload` is always `preventDefault()`ed (and a beforeunload dialog seen over the
  protocol is accepted): refresh, Stop and closing the IDE always win.
- **Records:** `sanitizeLogUrl` (log-buffer.ts) is applied to every record URL in main: credentials removed,
  `data:`/`javascript:` URLs (which carry content, possibly source code) reduced to scheme, media type and length,
  control characters removed, at most 500 characters. Project-file URLs are unchanged, so file/line attribution works.
- **Service workers:** requests marked `Service-Worker: script` are cancelled in `onBeforeSendHeaders`, so
  `register()` rejects; registrations left from older versions are removed at every start
  (`clearStorageData({ storages: ['serviceworkers'] })`).

## Consequences (incl. how it is verified on macOS arm64 and Windows x64)

- All of the page's network traffic is relayed through main (a socket pipe; no parsing). Fine for beginner pages and
  CDN assets; heavy downloads cost some main-process CPU.
- Pages cannot use services on this machine or the LAN at all — including a beginner's own API on `localhost:3000`
  or an intranet CDN on a private address. That is the intended boundary for the MVP (PLAN §4 excludes backends);
  a future "allow this local address" setting would be a new decision.
- Other local programs can connect to the proxy, but it only offers what they already have (public internet) with
  fewer rights; Chromium cannot authenticate to SOCKS5 proxies, so no secret is used.
- Residual: a page can still make Chromium perform DNS _lookups_ for arbitrary names (prefetch); it cannot connect.
- Every non-internal interface's network is refused; a VPN or tunnel interface with a very broad prefix would
  therefore refuse much of the internet (fails closed: an availability, not a safety, risk).
- Residual: the router's public (WAN) address is not known to the IDE; a router that hairpins connections to it
  would expose services that are port-forwarded to the internet anyway.
- Verified on macOS arm64 by `tests/integration/preview-proxy.test.ts` (rebinding name, LAN name, mixed answers,
  literals, own interface address, non-SOCKS client, UDP ASSOCIATE, resolution limits), `src/preview/*.test.ts` and
  e2e `tests/e2e/preview-isolation.spec.ts` (a `rebind.test` name mapped to 127.0.0.1 with `--host-resolver-rules`,
  `localtest.me`, the machine name, the LAN IP, `0.0.0.0`, WebSocket and image variants, service worker, dialogs,
  beforeunload). Without the proxy the same e2e reads the other local service through `rebind.test`, `localtest.me`
  and the LAN IP, and registers a service worker (checked while implementing). Windows x64: the same suites must run
  on the Windows dev machine / CI (harness/MANUAL-CHECKS.md#S05.5-windows).
