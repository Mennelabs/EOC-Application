/**
 * Reading a county's feed (layer-7 task F; REC-13) under the outbound rules
 * of ADR-0042 (OWASP SSRF): https only, a host name on 443 or 8443, every
 * resolved address public, the connection to the checked address, redirects
 * checked again, a size cap. A local server with a throwaway certificate
 * stands in for the county's portal.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:https';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { feedUrlProblem, publicGet } from '../src/public-get.ts';

function hasOpenssl(): boolean {
  try {
    execFileSync('openssl', ['version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

describe('feed addresses (ADR-0042)', () => {
  it('takes a public https host name only', () => {
    expect(feedUrlProblem('https://data.westwind.example.gov/sites.csv')).toBeNull();
    expect(feedUrlProblem('http://data.example.gov/x')).toMatch(/https/);
    expect(feedUrlProblem('https://10.0.0.5/x')).toMatch(/host name/);
    expect(feedUrlProblem('https://localhost/x')).toMatch(/public host name/);
    expect(feedUrlProblem('https://user:pw@data.example.gov/x')).toMatch(/user name/);
    expect(feedUrlProblem('https://data.example.gov:9200/x')).toMatch(/port/);
  });

  it('refuses a host that resolves to a private address, without connecting', async () => {
    const get = publicGet({ resolve: async () => ['10.1.2.3'] });
    expect(await get('https://portal.example.gov/feed.json')).toEqual({
      ok: false,
      error: 'The host name resolves to an address that is not public.',
    });
    const metadata = publicGet({ resolve: async () => ['169.254.169.254'] });
    expect((await metadata('https://portal.example.gov/feed.json')).ok).toBe(false);
  });
});

describe.skipIf(!hasOpenssl())('reading a feed from a portal (REC-13)', () => {
  let server: Server;
  let port = '';
  let ca = '';
  let dir = '';

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'cg-feed-'));
    execFileSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-days',
        '1',
        '-keyout',
        join(dir, 'key.pem'),
        '-out',
        join(dir, 'cert.pem'),
        '-subj',
        '/CN=portal.example.gov',
        '-addext',
        'subjectAltName=DNS:portal.example.gov',
      ],
      { stdio: 'ignore' },
    );
    ca = readFileSync(join(dir, 'cert.pem'), 'utf8');
    server = createServer({ key: readFileSync(join(dir, 'key.pem')), cert: ca }, (req, res) => {
      if (req.url === '/sites.csv') {
        res.writeHead(200, { 'content-type': 'text/csv' });
        res.end('name,address\nExercise Hall,1 Main St\n');
      } else if (req.url === '/moved') {
        res.writeHead(302, { location: '/sites.csv' });
        res.end();
      } else if (req.url === '/inside') {
        res.writeHead(302, { location: 'https://metadata.internal/latest' });
        res.end();
      } else if (req.url === '/big') {
        res.writeHead(200, { 'content-type': 'text/csv' });
        res.end('x'.repeat(4096));
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    port = String((server.address() as AddressInfo).port);
  });
  afterAll(async () => {
    await new Promise<void>((r) => server?.close(() => r()));
    rmSync(dir, { recursive: true, force: true });
  });

  const get = (maxBytes?: number) =>
    publicGet({
      resolve: async () => ['127.0.0.1'],
      allow: (address) => address === '127.0.0.1',
      ports: new Set(['', '443', '8443', port]),
      ca,
      timeoutMs: 3_000,
      ...(maxBytes ? { maxBytes } : {}),
    });

  it('reads the body from the checked address with the host name kept for TLS', async () => {
    const r = await get()(`https://portal.example.gov:${port}/sites.csv`);
    expect(r).toMatchObject({ ok: true, contentType: 'text/csv' });
    expect(r.ok && r.body).toContain('Exercise Hall');
  });

  it('follows a redirect only after checking it again; one to an inside name is refused', async () => {
    expect((await get()(`https://portal.example.gov:${port}/moved`)).ok).toBe(true);
    expect(await get()(`https://portal.example.gov:${port}/inside`)).toEqual({
      ok: false,
      error: 'The address must be a public host name.',
    });
  });

  it('stops at the size cap and says so; an error status is reported in words', async () => {
    expect(await get(1024)(`https://portal.example.gov:${port}/big`)).toMatchObject({
      ok: false,
      error: expect.stringMatching(/larger than/),
    });
    expect(await get()(`https://portal.example.gov:${port}/missing`)).toEqual({
      ok: false,
      error: 'The feed answered 404.',
    });
  });
});
