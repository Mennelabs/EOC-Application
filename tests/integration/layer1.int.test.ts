/**
 * Layer-1 acceptance against the running stack (`docker compose up` with the
 * synthetic WESTWIND seed loaded). Exercises the real chain: Keycloak token →
 * API → policy engine → RLS → audit, and the worker through the outbox.
 *
 * Requirement IDs are in the test names. Tokens come from the development
 * test client (direct grant), which exists only when IDP_DEV_DIRECT_GRANT is
 * on; interactive logins still require a passkey (SEC-07).
 */
import { describe, expect, it } from 'vitest';

const BASE = process.env['STACK_URL'] ?? 'https://localhost';
const MAIL = process.env['MAILPIT_URL'] ?? 'http://localhost:8025';
process.env['NODE_TLS_REJECT_UNAUTHORIZED'] = '0'; // Caddy local CA in development only.

const PASSWORD = 'Westwind-Exercise-2026!';
const RUN = Date.now().toString(36);

async function token(realm: string, user: string): Promise<string> {
  const res = await fetch(`${BASE}/auth/realms/${realm}/protocol/openid-connect/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'password',
      client_id: 'cg-tests',
      client_secret: 'cg-tests-dev-secret',
      username: user,
      password: PASSWORD,
    }),
  });
  const body = (await res.json()) as { access_token?: string; error_description?: string };
  if (!body.access_token) throw new Error(`token for ${user}@${realm}: ${body.error_description}`);
  return body.access_token;
}

interface Call {
  method?: string;
  body?: unknown;
  headers?: Record<string, string>;
  confirm?: string;
  version?: number;
  idempotencyKey?: string;
}

async function api(tok: string | null, path: string, call: Call = {}) {
  const headers: Record<string, string> = { ...(call.headers ?? {}) };
  if (tok) headers['authorization'] = `Bearer ${tok}`;
  if (call.body !== undefined) headers['content-type'] = 'application/json';
  if (call.confirm) {
    headers['x-confirm'] = 'true';
    headers['x-reason'] = call.confirm;
  }
  if (call.version !== undefined) headers['if-match'] = `"${call.version}"`;
  if (call.idempotencyKey) headers['idempotency-key'] = call.idempotencyKey;
  const res = await fetch(`${BASE}/api/v1${path}`, {
    method: call.method ?? (call.body !== undefined ? 'POST' : 'GET'),
    headers,
    ...(call.body !== undefined ? { body: JSON.stringify(call.body) } : {}),
  });
  const text = await res.text();
  let json: unknown;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = text;
  }
  return {
    status: res.status,
    body: json as Record<string, unknown> & unknown[],
    headers: res.headers,
  };
}

async function waitFor<T>(fn: () => Promise<T | undefined>, ms = 20_000): Promise<T> {
  const until = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v !== undefined) return v;
    if (Date.now() > until) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 1000));
  }
}

const dana = () => token('county', 'dana.director@example.org');
const admin = () => token('county', 'admin@example.org');
const security = () => token('county', 'security.admin@example.org');
const priya = () => token('county', 'priya.assessment@example.org');
const marcus = () => token('county', 'marcus.gis@example.org');
const tomas = () => token('county', 'tomas.pio@example.org');
const liaison = () => token('state', 'state.liaison@example.org');

describe('identity and default deny (SEC-06, SEC-07, G1, G2)', () => {
  it('a seeded staff member signs in and /me reflects roles loaded from the database', async () => {
    const me = await api(await dana(), '/me');
    expect(me.status).toBe(200);
    expect(me.body['roles']).toEqual([
      expect.objectContaining({ key: 'county_em_director', version: 1 }),
    ]);
  });

  it('public callers get the metadata and nothing else (BRD:FR-00.02)', async () => {
    expect((await fetch(`${BASE}/api/meta`)).status).toBe(200);
    expect((await api(null, '/me')).status).toBe(401);
    expect((await api(null, '/tenants')).status).toBe(401);
  });

  it('a role without a grant is denied generically; the denial is audited (AC-00A, MET-10)', async () => {
    const d = await dana();
    const denied = await api(d, '/legal-holds');
    expect(denied.status).toBe(403);
    expect(denied.body['message']).not.toMatch(/exist|grant|role/i);
    const audit = await api(
      await security(),
      '/audit?action=authz.deny&targetType=legal_hold&limit=5',
    );
    expect(audit.status).toBe(200);
    expect(audit.body.length).toBeGreaterThan(0);
  });

  it('SCL-01: a state liaison sees the hierarchy, never a county’s records without an agreement', async () => {
    const t = await liaison();
    const tenants = await api(t, '/tenants');
    expect(tenants.status).toBe(200);
    expect((tenants.body as { slug: string }[]).map((x) => x.slug)).toEqual(
      expect.arrayContaining(['state', 'county']),
    );
    const events = await api(t, '/events');
    expect(events.status).toBe(200);
    expect(events.body).toEqual([]);
  });
});

describe('save semantics (BRD:FR-00.04–00.07)', () => {
  it('AC-00C: the same Idempotency-Key replays the stored response instead of acting twice', async () => {
    const a = await admin();
    const key = crypto.randomUUID();
    const body = { email: `replay-${RUN}@example.org`, displayName: 'Replay Test' };
    const first = await api(a, '/accounts/invite', { body, idempotencyKey: key });
    expect(first.status).toBe(201);
    const second = await api(a, '/accounts/invite', { body, idempotencyKey: key });
    expect(second.status).toBe(201);
    expect(second.headers.get('idempotency-replayed')).toBe('true');
    expect(second.body['id']).toBe(first.body['id']);
    const reused = await api(a, '/accounts/invite', {
      body: { ...body, displayName: 'Different' },
      idempotencyKey: key,
    });
    expect(reused.status).toBe(422);
  });

  it('AC-00B: a stale If-Match is refused with the current record', async () => {
    const a = await admin();
    const me = await api(a, '/me');
    const res = await api(a, `/tenants/${me.body['tenantId']}`, {
      method: 'PATCH',
      body: { name: 'Should not apply' },
      version: 999,
      confirm: 'integration test',
    });
    expect(res.status).toBe(409);
    expect((res.body['details'] as { version: number }).version).toBeGreaterThan(0);
    const missing = await api(a, `/tenants/${me.body['tenantId']}`, {
      method: 'PATCH',
      body: { name: 'x' },
    });
    expect(missing.status).toBe(428);
  });

  it('ADM-01, NFR-09, WCAG 1.4.3: branding and languages are checked and recorded with a reason; residents see only the known fields', async () => {
    const a = await admin();
    const me = await api(a, '/me');
    const id = me.body['tenantId'] as string;
    const before = await api(a, `/tenants/${id}`);
    const original = {
      branding: before.body['branding'] as Record<string, unknown>,
      locales: before.body['locales'] as string[],
    };
    const patch = (body: unknown, version: number, confirm = 'integration test') =>
      api(a, `/tenants/${id}`, { method: 'PATCH', body, version, confirm });
    const v = before.body['version'] as number;
    // White text on yellow is unreadable; an unknown field and a plain-http site are refused.
    expect((await patch({ branding: { headerColor: '#ffcc00' } }, v)).status).toBe(400);
    expect((await patch({ branding: { script: 'x' } }, v)).status).toBe(400);
    expect((await patch({ branding: { website: 'http://westwind.example.gov' } }, v)).status).toBe(
      400,
    );
    // Residents always get English and Spanish; a language without reviewed pages is not offered.
    const english = await patch({ locales: ['en'] }, v);
    expect(english.status).toBe(400);
    expect(JSON.stringify(english.body)).toContain('English and Spanish are always offered');
    expect((await patch({ locales: ['en', 'es', 'vi'] }, v)).status).toBe(400);
    const branding = {
      publicName: { en: `Exercise Westwind OEM ${RUN}`, es: `Emergencias de Westwind ${RUN}` },
      website: 'https://westwind.example.gov',
      headerColor: '#0b4f6c',
    };
    const saved = await patch(
      { branding, locales: ['es', 'en', 'es'] },
      v,
      'Exercise: county branding',
    );
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    expect(saved.body).toMatchObject({ branding, locales: ['es', 'en'] });
    try {
      const intake = (await (await fetch(`${BASE}/api/public/intake/county/westwind`)).json()) as {
        tenant: { branding: unknown };
      };
      expect(intake.tenant.branding).toEqual(branding);
      const help = (await (await fetch(`${BASE}/api/public/help/county?lang=es`)).json()) as {
        tenant: { branding: unknown };
      };
      expect(help.tenant.branding).toEqual(branding);
      const audited = await api(
        await security(),
        `/audit?action=tenant.update&targetType=tenant&targetId=${id}&limit=5`,
      );
      expect(audited.status).toBe(200);
      expect((audited.body as unknown as { reason: string }[])[0]?.reason).toBe(
        'Exercise: county branding',
      );
    } finally {
      const back = await patch(
        original,
        saved.body['version'] as number,
        'integration test: restore',
      );
      expect(back.status, JSON.stringify(back.body)).toBe(200);
    }
  });
});

describe('second administrator (ADM-05 G6, Section 30.2)', () => {
  it('an administrator cannot approve their own request; a different administrator can, with confirmation', async () => {
    const a = await admin();
    const s = await security();
    const invited = await api(a, '/accounts/invite', {
      body: { email: `pio-${RUN}@example.org`, displayName: 'New PIO' },
      idempotencyKey: crypto.randomUUID(),
    });
    expect(invited.status).toBe(201);
    const accountId = invited.body['id'] as string;
    // Activate the invited account (consequential? no: activate is an admin action without confirmation)
    const activated = await api(a, `/accounts/${accountId}/activate`, {
      method: 'POST',
      body: {},
      version: invited.body['version'] as number,
    });
    expect(activated.status).toBe(200);

    const roles = await api(a, '/roles');
    const pio = (roles.body as { id: string; key: string }[]).find(
      (r) => r.key === 'public_information_officer',
    )!;
    const request = await api(a, '/permission-changes', {
      body: { kind: 'assign_role', accountId, roleId: pio.id, scope: {} },
      idempotencyKey: crypto.randomUUID(),
    });
    expect(request.status).toBe(201);
    const id = request.body['id'] as string;
    const version = request.body['version'] as number;

    const self = await api(a, `/permission-changes/${id}/approve`, {
      method: 'POST',
      version,
      confirm: 'self approval attempt',
    });
    expect(self.status).toBe(404); // asNotFound: the denial reveals nothing

    const unconfirmed = await api(s, `/permission-changes/${id}/approve`, {
      method: 'POST',
      version,
    });
    expect(unconfirmed.status).toBe(428);

    const approved = await api(s, `/permission-changes/${id}/approve`, {
      method: 'POST',
      version,
      confirm: 'WESTWIND exercise staffing',
    });
    expect(approved.status).toBe(200);
    expect(approved.body['status']).toBe('applied');

    const assignments = await api(s, `/role-assignments?accountId=${accountId}`);
    expect(assignments.status).toBe(200);
    expect(assignments.body.length).toBe(1);
  });
});

describe('break-glass (SEC-08) and audit (SEC-18)', () => {
  it('needs confirmation, notifies the security contact, freezes permission changes, and ends', async () => {
    const a = await admin();
    const unconfirmed = await api(a, '/break-glass', {
      body: { reason: 'Exercise WESTWIND: verify emergency access path', hours: 1 },
      idempotencyKey: crypto.randomUUID(),
    });
    expect(unconfirmed.status).toBe(428);

    const started = await api(a, '/break-glass', {
      body: { reason: 'Exercise WESTWIND: verify emergency access path', hours: 1 },
      idempotencyKey: crypto.randomUUID(),
      confirm: 'tabletop exercise',
    });
    expect(started.status).toBe(201);
    const id = started.body['id'] as string;

    // Worker emails the tenant security contact and records notified_at.
    const notified = await waitFor(async () => {
      const list = await api(a, '/break-glass');
      const row = (list.body as { id: string; notifiedAt: string | null }[]).find(
        (r) => r.id === id,
      );
      return row?.notifiedAt ? row : undefined;
    });
    expect(notified.notifiedAt).toBeTruthy();
    const mail = (await (await fetch(`${MAIL}/api/v1/search?query=emergency%20access`)).json()) as {
      total: number;
    };
    expect(mail.total).toBeGreaterThan(0);

    // Permission writes are frozen while the session is active (G6).
    const frozen = await api(a, '/permission-changes', {
      body: {
        kind: 'assign_role',
        accountId: crypto.randomUUID(),
        roleId: crypto.randomUUID(),
        scope: {},
      },
      idempotencyKey: crypto.randomUUID(),
    });
    expect(frozen.status).toBe(403);

    const current = (await api(a, '/break-glass')).body as { id: string; version: number }[];
    const ended = await api(a, `/break-glass/${id}/end`, {
      method: 'POST',
      version: current.find((r) => r.id === id)!.version,
    });
    expect(ended.status).toBe(200);
    expect(ended.body['endedAt']).toBeTruthy();
  });

  it('the chain verifies and the security administrator can read the log', async () => {
    const s = await security();
    const verify = await api(s, '/audit/verify');
    expect(verify.status).toBe(200);
    expect(verify.body['ok']).toBe(true);
    expect(verify.body['checked']).toBeGreaterThan(10);
    const reads = await api(s, '/audit?action=break_glass.start&limit=3');
    expect(reads.status).toBe(200);
    expect(reads.body.length).toBeGreaterThan(0);
  });
});

describe('restricted contact details (SEC-10, SEC-18, G7)', () => {
  it('stored encrypted, returned only to roles with the contact category, every read audited', async () => {
    const a = await admin();
    const phone = `+1314555${String(100 + (Date.now() % 100)).padStart(4, '0')}`;
    const created = await api(a, '/personnel', {
      body: {
        name: `Volunteer ${RUN}`,
        agency: 'Westwind COAD',
        skills: ['chainsaw'],
        contact: { phone, email: `vol-${RUN}@example.org` },
      },
      idempotencyKey: crypto.randomUUID(),
    });
    expect(created.status).toBe(201);
    const id = created.body['id'] as string;
    expect(created.body['contact']).toBeUndefined();

    const withContact = await api(await priya(), `/personnel/${id}`);
    expect(withContact.status).toBe(200);
    expect((withContact.body['contact'] as { phone: string }).phone).toBe(phone);

    const withoutContact = await api(await marcus(), `/personnel/${id}`);
    expect(withoutContact.status).toBe(200);
    expect(withoutContact.body['contact']).toBeUndefined();

    expect((await api(await tomas(), `/personnel/${id}`)).status).toBe(404);

    const lookup = await api(await priya(), `/personnel/lookup?phone=${encodeURIComponent(phone)}`);
    expect(lookup.status).toBe(200);
    expect((lookup.body as { id: string }[]).map((r) => r.id)).toEqual([id]);

    const audited = await api(
      await security(),
      `/audit?targetType=personnel&targetId=${id}&action=personnel.read`,
    );
    expect(audited.body.length).toBeGreaterThanOrEqual(2);
    expect((audited.body[0] as { classificationRead: string[] }).classificationRead).toContain(
      'contact',
    );
  });
});
