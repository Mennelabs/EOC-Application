/**
 * Outbound requests for reference connectors (ADR-0039). Each request must
 * name a host on the allowlist (configuration, then the connector's own
 * list); anything else is refused before a socket opens. Requests carry
 * geography only. Keys in query strings never reach logs or errors: URLs are
 * redacted before they are shown or stored. Timeouts and a few retries with
 * backoff cover slow or briefly failing federal services; a source that
 * stays down leaves the last good snapshot in use (SCL-06).
 */

export interface EgressHttp {
  getJson(url: string): Promise<unknown>;
  getText(url: string): Promise<string>;
}

export class EgressRefused extends Error {
  readonly host: string;
  constructor(host: string) {
    super(`reference source host not allowed: ${host}`);
    this.name = 'EgressRefused';
    this.host = host;
  }
}

export class SourceUnavailable extends Error {
  readonly url: string;
  readonly status: number | null;
  constructor(url: string, status: number | null, detail: string) {
    super(`reference source unavailable (${status ?? 'network'}): ${url} ${detail}`.trim());
    this.name = 'SourceUnavailable';
    this.url = url;
    this.status = status;
  }
}

const SECRET_PARAMS = ['key', 'api_key', 'apikey', 'token', 'access_token', 'client_secret'];

/** The URL with secret-looking query values replaced, for logs, errors and snapshots. */
export function redactUrl(url: string): string {
  try {
    const u = new URL(url);
    for (const name of [...u.searchParams.keys()])
      if (SECRET_PARAMS.includes(name.toLowerCase())) u.searchParams.set(name, 'REDACTED');
    return u.toString();
  } catch {
    return '(unparseable url)';
  }
}

export interface EgressOptions {
  allowedHosts: readonly string[];
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  retries?: number;
  /** NWS and others ask for a contact in the User-Agent. */
  userAgent: string;
  sleep?: (ms: number) => Promise<void>;
}

export function createEgressHttp(opts: EgressOptions): EgressHttp {
  const allowed = new Set(opts.allowedHosts.map((h) => h.toLowerCase()));
  const doFetch = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const retries = opts.retries ?? 2;
  const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));

  async function get(url: string, accept: string): Promise<Response> {
    const u = new URL(url);
    if (u.protocol !== 'https:') throw new EgressRefused(`${u.protocol}//${u.host}`);
    if (!allowed.has(u.hostname.toLowerCase())) throw new EgressRefused(u.hostname);
    let last: SourceUnavailable | null = null;
    for (let attempt = 0; attempt <= retries; attempt++) {
      if (attempt > 0) await sleep(1000 * 2 ** (attempt - 1));
      try {
        const res = await doFetch(url, {
          headers: { accept, 'user-agent': opts.userAgent },
          signal: AbortSignal.timeout(timeoutMs),
          redirect: 'error',
        });
        if (res.ok) return res;
        last = new SourceUnavailable(redactUrl(url), res.status, res.statusText);
        if (res.status !== 429 && res.status < 500) throw last;
      } catch (err) {
        if (
          err instanceof SourceUnavailable &&
          err.status !== null &&
          err.status < 500 &&
          err.status !== 429
        )
          throw err;
        last =
          err instanceof SourceUnavailable
            ? err
            : new SourceUnavailable(redactUrl(url), null, (err as Error).name);
      }
    }
    throw last ?? new SourceUnavailable(redactUrl(url), null, 'no response');
  }

  return {
    async getJson(url) {
      const res = await get(url, 'application/json, application/geo+json');
      return res.json();
    },
    async getText(url) {
      const res = await get(url, 'text/plain, text/csv, */*');
      return res.text();
    },
  };
}
