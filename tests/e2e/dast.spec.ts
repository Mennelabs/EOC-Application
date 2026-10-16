/**
 * Dynamic security checks against the running stack (SEC-15 "SAST/DAST …
 * in CI", SEC-09, NFR-02): what an outsider sees from the gateway, with no
 * account. Every page the public or staff open carries the security headers;
 * plain HTTP goes to HTTPS; no response names the server software; staff
 * routes refuse a missing or forged token with the error envelope and no
 * internals; malformed input is refused without a stack trace or database
 * text; another origin is never granted the API; TRACE is not served; a
 * traversal is not found; and the identity provider will not send a sign-in
 * to an address it does not know. Runs once, on the desktop project.
 */
import { expect, test, type APIRequestContext, type APIResponse } from '@playwright/test';
import { BASE } from './support/console.ts';

const PAGES = ['/', '/county/help', '/county/westwind', '/console/', '/field/'];
const STAFF_API = [
  '/api/v1/missions',
  '/api/v1/reports',
  '/api/v1/personnel',
  '/api/v1/audit',
  '/api/v1/reentry-passes',
  '/api/v1/resources',
];
/** What an error body must never contain: stack frames, file paths, database or driver text. */
const LEAK =
  /\bat [\w$.<>]+ \(|node_modules|\/repo\/|\.ts:\d+|kysely|postgres|pg_|syntax error at|SELECT |stack/i;

test.describe('dynamic security checks (DAST)', () => {
  // One pass is enough: the phone project emulates a mobile browser, the gateway is the same.
  test.skip(({ isMobile }) => isMobile, 'runs on the desktop project');

  const headers = (r: APIResponse) => r.headers();

  test('SEC-15, SEC-09: every page carries the security headers and names no server software', async ({
    request,
  }) => {
    for (const path of PAGES) {
      const res = await request.get(path);
      expect(res.status(), path).toBe(200);
      const h = headers(res);
      const csp = h['content-security-policy'] ?? '';
      expect(csp, `${path} CSP`).toContain("frame-ancestors 'none'");
      expect(csp, `${path} CSP`).toContain("default-src 'self'");
      expect(csp, `${path} CSP`).not.toContain("'unsafe-eval'");
      expect(csp, `${path} scripts`).not.toMatch(/script-src[^;]*'unsafe-inline'/);
      expect(h['strict-transport-security'], `${path} HSTS`).toMatch(/max-age=\d{7,}/);
      expect(h['x-content-type-options'], path).toBe('nosniff');
      expect(h['referrer-policy'], path).toBe('no-referrer');
      expect(h['x-powered-by'], path).toBeUndefined();
      expect(h['server'] ?? '', `${path} server`).not.toMatch(/\d/);
    }
    // The API's own HTML pages (a resource page, the media sheet) carry their own policy.
    const media = await request.get('/api/public/help/county/media?lang=en');
    expect(media.status()).toBe(200);
    expect(headers(media)['content-security-policy']).toContain("default-src 'none'");
    expect(headers(media)['content-security-policy']).toContain("form-action 'none'");
  });

  test('SEC-09: plain HTTP is redirected to HTTPS, never served', async ({ playwright }) => {
    const http = await playwright.request.newContext({ ignoreHTTPSErrors: true });
    const url = new URL(BASE);
    url.protocol = 'http:';
    url.pathname = '/county/help';
    const res = await http.get(url.toString(), { maxRedirects: 0 }).catch(() => null);
    // A gateway that does not listen on port 80 at all serves nothing in clear text either.
    if (res) {
      expect([301, 302, 307, 308]).toContain(res.status());
      expect(res.headers()['location'] ?? '').toMatch(/^https:\/\//);
    }
    await http.dispose();
  });

  test('ADM-05, SEC-09: staff routes refuse a missing or forged token with the envelope and no internals', async ({
    request,
  }) => {
    const forged = [
      'Bearer not-a-token',
      // An unsigned token ("alg": "none") claiming to be someone.
      `Bearer ${Buffer.from('{"alg":"none","typ":"JWT"}').toString('base64url')}.${Buffer.from(
        JSON.stringify({ sub: 'x', iss: `${BASE}/auth/realms/county`, exp: 4102444800 }),
      ).toString('base64url')}.`,
    ];
    for (const path of STAFF_API) {
      const none = await request.get(path);
      expect(none.status(), path).toBe(401);
      const body = await none.text();
      expect(JSON.parse(body)).toMatchObject({
        code: expect.any(String),
        message: expect.any(String),
      });
      expect(body, path).not.toMatch(LEAK);
      for (const authorization of forged) {
        const res = await request.get(path, { headers: { authorization } });
        expect(res.status(), `${path} with a forged token`).toBe(401);
        expect(await res.text(), path).not.toMatch(LEAK);
      }
    }
  });

  test('SEC-09: malformed input is refused without a stack trace or database text', async ({
    request,
  }) => {
    const cases: [string, Parameters<APIRequestContext['post']>[1]][] = [
      [
        '/api/public/intake/county/westwind/submissions',
        { headers: { 'content-type': 'application/json' }, data: '{"executionId": ' },
      ],
      [
        '/api/public/intake/county/lookup/start',
        { data: { referenceCode: "x' OR '1'='1", contact: '<script>alert(1)</script>' } },
      ],
      ['/api/public/intake/county/photos', { data: { executionId: 'not-a-uuid', bytes: -1 } }],
      ['/api/public/help/county/ask', { data: { text: 'a'.repeat(100_000) } }],
    ];
    for (const [path, init] of cases) {
      const res = await request.post(path, init);
      // The lookup answers the same whatever is sent, so it reveals no match (RULE-17).
      if (!path.endsWith('/lookup/start')) expect(res.status(), path).toBeGreaterThanOrEqual(400);
      expect(res.status(), path).toBeLessThan(500);
      const body = await res.text();
      expect(body, path).not.toMatch(LEAK);
      expect(body, path).not.toContain('<script>');
    }
  });

  test('SEC-09: another origin is never granted the API', async ({ request }) => {
    for (const path of ['/api/v1/missions', '/api/public/help/county']) {
      const pre = await request.fetch(path, {
        method: 'OPTIONS',
        headers: {
          origin: 'https://evil.example',
          'access-control-request-method': 'GET',
          'access-control-request-headers': 'authorization',
        },
      });
      const h = headers(pre);
      expect(h['access-control-allow-origin'] ?? '', path).not.toBe('https://evil.example');
      expect(h['access-control-allow-origin'] ?? '', path).not.toBe('*');
      const get = await request.get(path, { headers: { origin: 'https://evil.example' } });
      expect(headers(get)['access-control-allow-origin'] ?? '', path).not.toBe(
        'https://evil.example',
      );
      expect(headers(get)['access-control-allow-credentials'], path).toBeUndefined();
    }
  });

  test("NFR-10, SEC-09: the services' metrics are never served through the gateway", async ({
    request,
  }) => {
    for (const path of ['/metrics', '/api/metrics', '/api/v1/metrics', '/api/public/metrics']) {
      const res = await request.get(path);
      const body = await res.text();
      expect(body, path).not.toContain('# TYPE');
      expect(body, path).not.toContain('cg_http_requests_total');
    }
  });

  test('SEC-09: TRACE is not served and a path traversal finds nothing', async ({ request }) => {
    for (const path of ['/', '/api/v1/missions', '/api/public/help/county']) {
      const res = await request.fetch(path, { method: 'TRACE' });
      expect(res.status(), `TRACE ${path}`).not.toBe(200);
      expect(await res.text()).not.toMatch(/TRACE \/|^Via:/m);
    }
    for (const path of [
      '/api/public/help/..%2f..%2f..%2fetc%2fpasswd',
      '/county/..%2f..%2fetc%2fpasswd',
      '/console/%2e%2e/%2e%2e/etc/passwd',
    ]) {
      const res = await request.get(path);
      expect(await res.text(), path).not.toContain('root:x:0:0');
    }
  });

  test('SEC-07, SEC-09: the identity provider does not send a sign-in to an address it does not know', async ({
    request,
  }) => {
    const auth = new URL(`${BASE}/auth/realms/county/protocol/openid-connect/auth`);
    auth.searchParams.set('client_id', 'cg-console');
    auth.searchParams.set('response_type', 'code');
    auth.searchParams.set('scope', 'openid');
    auth.searchParams.set('redirect_uri', 'https://evil.example/callback');
    const res = await request.get(auth.toString(), { maxRedirects: 0 });
    expect(res.headers()['location'] ?? '').not.toContain('evil.example');
    expect(res.status()).toBeGreaterThanOrEqual(400);
  });
});
