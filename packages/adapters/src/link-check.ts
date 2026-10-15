/**
 * Checking an outside link on a public resource page (PUB-18, MET-07): does
 * it still answer? The URL is typed by staff, so the check must not become
 * a way into the stack's own network (OWASP SSRF), the same rule as
 * webhooks (ADR-0042):
 *
 * - http or https, a host on a standard web port (80, 443, 8080, 8443), no
 *   user or password;
 * - every address the host resolves to must be public, and the request goes
 *   to that checked address (no second lookup to rebind); TLS still checks
 *   the host name;
 * - at most three redirects, each checked the same way before it is
 *   followed; five seconds per request;
 * - HEAD first, then GET when the server refuses HEAD (403, 405); the body
 *   is never read.
 *
 * The answer is only "answers" or "does not": a refused URL reads as broken,
 * so nothing about the inside of the stack shows on the console.
 */
import { lookup } from 'node:dns/promises';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import { isPublicAddress, pinnedLookup, type Resolver } from './webhooks.ts';

const PORTS = new Set(['', '80', '443', '8080', '8443']);
const MAX_REDIRECTS = 3;

export type LinkCheck = (url: string) => Promise<boolean>;

/** Why a link may not be checked, or null when it may (no lookup here). */
export function linkUrlProblem(raw: string, ports: ReadonlySet<string> = PORTS): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return 'not a URL';
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return 'not http or https';
  if (url.username || url.password) return 'user or password in the URL';
  if (!ports.has(url.port)) return 'not a standard web port';
  const host = url.hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost')) return 'a local host';
  return null;
}

const systemResolver: Resolver = async (host) =>
  (await lookup(host, { all: true, verbatim: true })).map((a) => a.address);

export function publicLinkCheck(
  opts: {
    resolve?: Resolver;
    timeoutMs?: number;
    /** Which resolved addresses and ports may be reached; tests widen them to a local server. */
    allow?: (address: string) => boolean;
    ports?: ReadonlySet<string>;
  } = {},
): LinkCheck {
  const resolve = opts.resolve ?? systemResolver;
  const timeoutMs = opts.timeoutMs ?? 5_000;
  const allow = opts.allow ?? isPublicAddress;
  const ports = opts.ports ?? PORTS;

  /** One request to a checked address; null when it cannot be made or fails. */
  async function ask(url: URL, method: 'HEAD' | 'GET'): Promise<IncomingMessage | null> {
    if (linkUrlProblem(url.href, ports)) return null;
    const host = url.hostname.replace(/^\[|\]$/g, '');
    let addresses: string[];
    try {
      addresses = isIP(host) ? [host] : await resolve(host);
    } catch {
      return null;
    }
    if (!addresses.length || !addresses.every(allow)) return null;
    const address = addresses[0]!;
    const send = url.protocol === 'https:' ? httpsRequest : httpRequest;
    return new Promise((done) => {
      const req = send(
        {
          host,
          ...(url.protocol === 'https:' && !isIP(host) ? { servername: host } : {}),
          port: url.port || (url.protocol === 'https:' ? 443 : 80),
          path: `${url.pathname}${url.search}`,
          method,
          headers: { 'user-agent': 'link-check/1', accept: '*/*' },
          // Connect to the address already checked: no second lookup.
          lookup: pinnedLookup(address),
          timeout: timeoutMs,
        },
        (res) => {
          res.resume();
          done(res);
        },
      );
      req.on('timeout', () => req.destroy(new Error('timeout')));
      req.on('error', () => done(null));
      req.end();
    });
  }

  return async (raw) => {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      return false;
    }
    let method: 'HEAD' | 'GET' = 'HEAD';
    for (let hop = 0; hop <= MAX_REDIRECTS;) {
      const res = await ask(url, method);
      if (!res) return false;
      const status = res.statusCode ?? 0;
      if (status >= 200 && status < 300) return true;
      if (status >= 300 && status < 400 && res.headers.location) {
        try {
          url = new URL(res.headers.location, url);
        } catch {
          return false;
        }
        hop++;
        continue;
      }
      if (method === 'HEAD' && (status === 403 || status === 405)) {
        method = 'GET';
        continue;
      }
      return false;
    }
    return false;
  };
}
