/**
 * Network egress guard for the provider SDKs (S36.1 security review, decision 0025: "network access only from main to
 * the two provider hosts").
 *
 * Both SDKs read environment variables when a client is built: a different endpoint (`ANTHROPIC_BASE_URL`,
 * `OPENAI_BASE_URL`), extra credentials (`ANTHROPIC_AUTH_TOKEN`, `OPENAI_ORG_ID`…), extra headers
 * (`ANTHROPIC_CUSTOM_HEADERS`, `OPENAI_CUSTOM_HEADERS`) and debug logging of whole request bodies (`ANTHROPIC_LOG`,
 * `OPENAI_LOG`). Those are common on developer machines; none of them may redirect a user's key or code. The providers
 * therefore pass every such option explicitly, and every request goes through {@link guardedFetch}, which only lets
 * requests to the provider's own origin through and drops headers injected from the environment.
 */
export const PROVIDER_ORIGINS = {
  anthropic: 'https://api.anthropic.com',
  openai: 'https://api.openai.com',
} as const;

/** Thrown for a request to any other host (never sent). */
export class EgressBlockedError extends Error {
  constructor() {
    super('request to a host other than the AI provider was blocked');
    this.name = 'EgressBlockedError';
  }
}

/** Header names the SDK would add from a `*_CUSTOM_HEADERS` variable ("Name: value" per line), lowercased. */
export function envHeaderNames(value: string | undefined): readonly string[] {
  if (!value) return [];
  const names: string[] = [];
  for (const line of value.split('\n')) {
    const colon = line.indexOf(':');
    if (colon > 0) names.push(line.slice(0, colon).trim().toLowerCase());
  }
  return names.filter((n) => n !== '');
}

function urlOf(input: string | URL | Request): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

/**
 * A fetch that sends only to `origin` and removes the headers named in the given custom-headers environment variable
 * (read at request time, like the SDK does at construction).
 */
export function guardedFetch(
  origin: string,
  customHeadersVar: string,
  base: typeof fetch = globalThis.fetch,
): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    let target: URL;
    try {
      target = new URL(urlOf(input));
    } catch {
      throw new EgressBlockedError();
    }
    if (target.origin !== origin) throw new EgressBlockedError();
    // A redirect could carry the key header to another host: the providers never redirect API calls, so refuse.
    const guarded: RequestInit = { ...init, redirect: 'error' };
    const strip = envHeaderNames(process.env[customHeadersVar]);
    if (strip.length > 0 && init?.headers !== undefined) {
      const headers = new Headers(init.headers);
      for (const name of strip) headers.delete(name);
      guarded.headers = headers;
    }
    return base(input, guarded);
  }) as typeof fetch;
}

/** SDK loggers that never print: debug logging would write prompts and code to the console. */
export const SILENT_LOGGER = {
  error: () => undefined,
  warn: () => undefined,
  info: () => undefined,
  debug: () => undefined,
};
