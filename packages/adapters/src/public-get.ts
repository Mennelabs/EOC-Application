/**
 * Reading a county's own public data feed (layer-7 task F; REC-13): an
 * open-data portal or a 211/HSDS service directory the county names. The URL
 * is typed by an administrator, so the read follows the outbound rules of
 * ADR-0042 (OWASP SSRF):
 *
 * - https only, a host name (never an address literal) on port 443 or 8443,
 *   no user or password, not a local or single-label name;
 * - every address the host resolves to must be public, and the connection
 *   goes to that checked address (no second lookup to rebind); TLS still
 *   checks the host name;
 * - at most three redirects, each checked the same way before it is
 *   followed; 15 seconds per request; the body is cut off at 5 MB.
 *
 * Only the body comes back. A refusal or failure carries a short reason in
 * words, never anything learned about the inside of the stack.
 */
import { lookup } from 'node:dns/promises';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import { isPublicAddress, pinnedLookup, webhookUrlProblem, type Resolver } from './webhooks.ts';

export type PublicGetResult =
  | { ok: true; body: string; contentType: string | null; url: string }
  | { ok: false; error: string };

export type PublicGet = (url: string) => Promise<PublicGetResult>;

const MAX_REDIRECTS = 3;
const MAX_BYTES = 5 * 1024 * 1024;

/** Why a feed URL may not be read, or null when it may (no lookup here). */
export function feedUrlProblem(raw: string, ports?: ReadonlySet<string>): string | null {
  return webhookUrlProblem(raw, ports);
}

const systemResolver: Resolver = async (host) =>
  (await lookup(host, { all: true, verbatim: true })).map((a) => a.address);

export function publicGet(
  opts: {
    resolve?: Resolver;
    timeoutMs?: number;
    maxBytes?: number;
    /** Tests only: a local server's address, port and certificate authority. */
    allow?: (address: string) => boolean;
    ports?: ReadonlySet<string>;
    ca?: string;
    userAgent?: string;
  } = {},
): PublicGet {
  const resolve = opts.resolve ?? systemResolver;
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const maxBytes = opts.maxBytes ?? MAX_BYTES;
  const allow = opts.allow ?? isPublicAddress;

  type Hop =
    | { kind: 'body'; body: string; contentType: string | null }
    | { kind: 'redirect'; location: string }
    | { kind: 'error'; error: string };

  async function once(url: URL): Promise<Hop> {
    const problem = feedUrlProblem(url.href, opts.ports);
    if (problem) return { kind: 'error', error: problem };
    let addresses: string[];
    try {
      addresses = await resolve(url.hostname);
    } catch {
      return { kind: 'error', error: 'The host name did not resolve.' };
    }
    if (!addresses.length || !addresses.every(allow))
      return { kind: 'error', error: 'The host name resolves to an address that is not public.' };
    const address = addresses[0]!;
    return new Promise<Hop>((done) => {
      const req = httpsRequest(
        {
          host: url.hostname,
          ...(isIP(url.hostname) ? {} : { servername: url.hostname }),
          port: url.port || 443,
          path: `${url.pathname}${url.search}`,
          method: 'GET',
          headers: {
            accept: 'application/json, application/geo+json, text/csv, */*;q=0.5',
            'user-agent': opts.userAgent ?? 'resource-discovery/1',
          },
          // Connect to the address already checked: no second lookup.
          lookup: pinnedLookup(address),
          ...(opts.ca ? { ca: opts.ca } : {}),
          timeout: timeoutMs,
        },
        (res) => {
          const status = res.statusCode ?? 0;
          if (status >= 300 && status < 400 && res.headers.location) {
            res.resume();
            done({ kind: 'redirect', location: res.headers.location });
            return;
          }
          if (status < 200 || status >= 300) {
            res.resume();
            done({ kind: 'error', error: `The feed answered ${status}.` });
            return;
          }
          const chunks: Buffer[] = [];
          let size = 0;
          let cut = false;
          res.on('data', (c: Buffer) => {
            if (cut) return;
            size += c.length;
            if (size > maxBytes) {
              cut = true;
              done({
                kind: 'error',
                error: `The feed is larger than ${Math.round(maxBytes / 1024 / 1024) || 1} MB.`,
              });
              res.destroy();
              return;
            }
            chunks.push(c);
          });
          res.on('end', () => {
            if (cut) return;
            done({
              kind: 'body',
              body: Buffer.concat(chunks).toString('utf8'),
              contentType: res.headers['content-type'] ?? null,
            });
          });
          res.on('error', () => done({ kind: 'error', error: 'The feed stopped answering.' }));
        },
      );
      req.on('timeout', () => req.destroy(new Error('timeout')));
      req.on('error', (err) =>
        done({
          kind: 'error',
          error:
            err.message === 'timeout'
              ? `No answer within ${Math.round(timeoutMs / 1000)} seconds.`
              : 'Could not connect.',
        }),
      );
      req.end();
    });
  }

  return async (raw) => {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      return { ok: false, error: 'Enter a full address starting with https://.' };
    }
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const r = await once(url);
      if (r.kind === 'body')
        return { ok: true, body: r.body, contentType: r.contentType, url: url.href };
      if (r.kind === 'error') return { ok: false, error: r.error };
      try {
        url = new URL(r.location, url);
      } catch {
        return { ok: false, error: 'The feed redirected to an address that is not a URL.' };
      }
    }
    return { ok: false, error: 'The feed redirected too many times.' };
  };
}
