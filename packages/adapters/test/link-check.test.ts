/**
 * The outside-link check (PUB-18, MET-07; OWASP SSRF as ADR-0042): only
 * http and https on standard web ports, only public addresses, connected to
 * the address checked, redirects checked the same way and at most three.
 * The local server stands in for a public site through the injected
 * resolver, address rule and ports.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { linkUrlProblem, publicLinkCheck } from '../src/link-check.ts';

describe('outside-link check', () => {
  let server: Server;
  let port = '';
  const seen: string[] = [];

  beforeAll(async () => {
    server = createServer((req, res) => {
      seen.push(`${req.method} ${req.headers.host} ${req.url}`);
      const at = (path: string) => `http://site.example:${port}${path}`;
      switch (req.url) {
        case '/ok':
          return res.writeHead(200).end();
        case '/gone':
          return res.writeHead(404).end();
        case '/no-head':
          return res.writeHead(req.method === 'HEAD' ? 405 : 200).end();
        case '/moved':
          return res.writeHead(301, { location: at('/ok') }).end();
        case '/inside':
          return res.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data/' }).end();
        case '/loop':
          return res.writeHead(302, { location: at('/loop') }).end();
        default:
          return res.writeHead(500).end();
      }
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    port = String((server.address() as AddressInfo).port);
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  // site.example resolves to the local server, which stands in for a public address.
  const check = () =>
    publicLinkCheck({
      resolve: async (host) => (host === 'site.example' ? ['127.0.0.1'] : ['10.1.2.3']),
      allow: (address) => address === '127.0.0.1',
      ports: new Set(['', '80', '443', port]),
      timeoutMs: 2_000,
    });
  const url = (path: string) => `http://site.example:${port}${path}`;

  it('PUB-18: a page that answers is current; one that does not is broken', async () => {
    expect(await check()(url('/ok'))).toBe(true);
    expect(await check()(url('/gone'))).toBe(false);
    // A server that refuses HEAD is asked with GET.
    expect(await check()(url('/no-head'))).toBe(true);
    // The request went to the checked address with the host name kept.
    expect(seen).toContain(`HEAD site.example:${port} /ok`);
  });

  it('follows a redirect to a public page, never one inside, and at most three', async () => {
    expect(await check()(url('/moved'))).toBe(true);
    seen.length = 0;
    expect(await check()(url('/inside'))).toBe(false);
    expect(await check()(url('/loop'))).toBe(false);
    expect(seen.filter((s) => s.endsWith('/loop'))).toHaveLength(4);
  });

  it('OWASP SSRF: refuses private addresses, other schemes, other ports and credentials without connecting', async () => {
    seen.length = 0;
    const real = publicLinkCheck({ resolve: async () => ['10.0.0.8'] });
    expect(await real('https://intranet.example/')).toBe(false);
    expect(await publicLinkCheck()('http://127.0.0.1/')).toBe(false);
    expect(await publicLinkCheck()('http://[::1]/')).toBe(false);
    expect(await publicLinkCheck()('http://169.254.169.254/latest/meta-data/')).toBe(false);
    expect(
      await publicLinkCheck({ resolve: async () => ['93.184.216.34', '192.168.1.5'] })(
        'https://mixed.example/',
      ),
    ).toBe(false);
    expect(seen).toEqual([]);
    expect(linkUrlProblem('https://www.ready.gov/floods')).toBeNull();
    expect(linkUrlProblem('http://example.org:8080/a')).toBeNull();
    expect(linkUrlProblem('ftp://example.org/')).toBe('not http or https');
    expect(linkUrlProblem('file:///etc/passwd')).toBe('not http or https');
    expect(linkUrlProblem('https://example.org:5432/')).toBe('not a standard web port');
    expect(linkUrlProblem('https://user:pw@example.org/')).toBe('user or password in the URL');
    expect(linkUrlProblem('http://localhost/')).toBe('a local host');
    expect(linkUrlProblem('not a url')).toBe('not a URL');
  });
});
