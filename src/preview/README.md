# src/preview — static server and preview lifecycle

Loopback-only static server confined to the project root (realpath checks, GET/HEAD only, Host check), preview
state machine, WebContentsView creation with sandboxing and per-project partitions (PLAN §8).

Network and page guards (decisions 0015, 0016): `preview-proxy.ts` + `address-policy.ts` — every request of the
preview session goes through a SOCKS5 proxy in main that allows only the project server (`127.0.0.1:<port>`) and
public internet addresses, deciding on the resolved address; `page-guard.ts` — a script installed over the DevTools
protocol before page scripts (pages, iframes, workers) that rate-limits the console and reports `alert()`.
