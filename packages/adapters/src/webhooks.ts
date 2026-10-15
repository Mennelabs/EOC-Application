/**
 * Outbound webhooks (layer-6 task H; SCL-09): where a delivery may go, how
 * it is signed, and how it is sent.
 *
 * - Where: HTTPS only, a host name (never an address literal), no user or
 *   password in the URL, port 443 or 8443; and when sending, every address
 *   the name resolves to must be public, and the connection goes to that
 *   checked address (no second lookup to rebind), so a webhook cannot
 *   reach the stack's own network or a cloud metadata service (OWASP SSRF).
 *   Redirects are not followed.
 * - Signed: the Standard Webhooks scheme. Headers webhook-id,
 *   webhook-timestamp and webhook-signature "v1,<base64 HMAC-SHA256 of
 *   id.timestamp.body>" with the secret "whsec_<base64>". Receivers can
 *   check it with any Standard Webhooks library.
 */
import { createHmac, randomBytes } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { request as httpsRequest } from 'node:https';
import { BlockList, isIP, type LookupFunction } from 'node:net';

export const WEBHOOK_EVENTS = ['official_report.issued', 'export.ready'] as const;
export type WebhookEventName = (typeof WEBHOOK_EVENTS)[number];

const ALLOWED_PORTS = new Set(['', '443', '8443']);

/** Why a URL may not be a webhook, or null when it may (no lookup: that is done when sending). */
export function webhookUrlProblem(
  raw: string,
  ports: ReadonlySet<string> = ALLOWED_PORTS,
): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return 'Enter a full address starting with https://.';
  }
  if (url.protocol !== 'https:') return 'The address must start with https://.';
  if (url.username || url.password) return 'The address may not hold a user name or password.';
  if (!ports.has(url.port)) return 'Use the standard HTTPS port (443) or 8443.';
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (isIP(host)) return 'Use a host name, not an IP address.';
  if (!host.includes('.') || /(^|\.)(localhost|local|internal|localdomain|home\.arpa)$/i.test(host))
    return 'The address must be a public host name.';
  if (raw.length > 500) return 'The address is too long.';
  return null;
}

const PRIVATE = new BlockList();
for (const [net, bits] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const)
  PRIVATE.addSubnet(net, bits, 'ipv4');
for (const [net, bits] of [
  ['::', 128],
  ['::1', 128],
  ['64:ff9b::', 96],
  ['100::', 64],
  ['2001:db8::', 32],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
] as const)
  PRIVATE.addSubnet(net, bits, 'ipv6');

/** Is this address one a webhook may be sent to? */
export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !PRIVATE.check(address, 'ipv4');
  if (family !== 6) return false;
  // An IPv4-mapped address is judged as the IPv4 address it carries; any
  // other spelling of one is refused. (BlockList matches IPv4 against mapped
  // IPv6 rules, so no ::ffff:0:0/96 rule is listed above.)
  if (/^::ffff:/i.test(address)) {
    const v4 = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(address)?.[1];
    return v4 !== undefined && isIP(v4) === 4 && !PRIVATE.check(v4, 'ipv4');
  }
  return !PRIVATE.check(address, 'ipv6');
}

/** A new signing secret, shown once to the administrator who asked for the webhook. */
export function newWebhookSecret(): string {
  return `whsec_${randomBytes(24).toString('base64')}`;
}

/** The Standard Webhooks headers for one delivery. */
export function signWebhook(
  secret: string,
  id: string,
  timestamp: number,
  body: string,
): Record<string, string> {
  const key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
  const sig = createHmac('sha256', key).update(`${id}.${timestamp}.${body}`).digest('base64');
  return {
    'webhook-id': id,
    'webhook-timestamp': String(timestamp),
    'webhook-signature': `v1,${sig}`,
  };
}

export interface WebhookPost {
  url: string;
  headers: Record<string, string>;
  body: string;
}

export interface WebhookResult {
  /** HTTP status, or null when nothing came back. */
  status: number | null;
  /** Why it failed, in a few words; never the receiver's body. */
  error: string | null;
}

/** Sends one delivery; injected in tests. */
export type WebhookSender = (post: WebhookPost) => Promise<WebhookResult>;

/** Resolves a host to its addresses; injected in tests. */
export type Resolver = (host: string) => Promise<string[]>;

/**
 * A lookup that always answers with the address already checked, so the
 * connection goes there and nowhere else (no second lookup to rebind).
 * Node asks for every address (`all`, to try IPv4 and IPv6 in turn) when
 * it connects; answering that call with a single address fails the
 * connection, so both forms are answered.
 */
export function pinnedLookup(address: string): LookupFunction {
  const family = isIP(address);
  return (_host, options, callback) => {
    if (options.all) callback(null, [{ address, family }]);
    else callback(null, address, family);
  };
}

const systemResolver: Resolver = async (host) =>
  (await lookup(host, { all: true, verbatim: true })).map((a) => a.address);

/**
 * The sender used in the stack: checks the URL again, resolves the host,
 * refuses unless every address is public, then connects to the first
 * checked address with the host name kept for TLS (SNI and certificate
 * check). Ten seconds at most; 2xx is success; redirects are failures.
 */
export function httpsWebhookSender(
  opts: {
    resolve?: Resolver;
    timeoutMs?: number;
    /** Tests only: a local receiver's address, port and certificate authority. */
    allow?: (address: string) => boolean;
    ports?: ReadonlySet<string>;
    ca?: string;
  } = {},
): WebhookSender {
  const resolve = opts.resolve ?? systemResolver;
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const allow = opts.allow ?? isPublicAddress;
  return async ({ url, headers, body }) => {
    const problem = webhookUrlProblem(url, opts.ports);
    if (problem) return { status: null, error: problem };
    const target = new URL(url);
    let addresses: string[];
    try {
      addresses = await resolve(target.hostname);
    } catch {
      return { status: null, error: 'The host name did not resolve.' };
    }
    if (!addresses.length || !addresses.every(allow))
      return { status: null, error: 'The host name resolves to an address that is not public.' };
    const address = addresses[0]!;
    return new Promise<WebhookResult>((done) => {
      const req = httpsRequest(
        {
          host: target.hostname,
          servername: target.hostname,
          port: target.port || 443,
          path: `${target.pathname}${target.search}`,
          method: 'POST',
          headers: {
            ...headers,
            'content-type': 'application/json',
            'content-length': Buffer.byteLength(body),
            'user-agent': 'webhook-delivery/1',
          },
          // Connect to the address already checked: no second lookup.
          lookup: pinnedLookup(address),
          ...(opts.ca ? { ca: opts.ca } : {}),
          timeout: timeoutMs,
        },
        (res) => {
          res.resume();
          const status = res.statusCode ?? null;
          done({
            status,
            error:
              status !== null && status >= 200 && status < 300
                ? null
                : status !== null && status >= 300 && status < 400
                  ? 'The receiver answered with a redirect; redirects are not followed.'
                  : `The receiver answered ${status}.`,
          });
        },
      );
      req.on('timeout', () => req.destroy(new Error('timeout')));
      req.on('error', (err) =>
        done({
          status: null,
          error: err.message === 'timeout' ? 'No answer within 10 seconds.' : 'Could not connect.',
        }),
      );
      req.end(body);
    });
  };
}

/** Wait before attempt n+1 (1 min, 5 min, 30 min, 2 h, then 6 h), up to MAX attempts. */
export const WEBHOOK_MAX_ATTEMPTS = 8;
export function webhookBackoffMs(attempts: number): number {
  const steps = [60_000, 300_000, 1_800_000, 7_200_000];
  return steps[attempts - 1] ?? 21_600_000;
}
