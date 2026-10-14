/**
 * The platform's side of the CJIS enclave against a real PostgreSQL
 * (layer-5 task D; SEC-12, PPL-01, BRD:FR-07.02, BRD:FR-07.04, ADM-05,
 * RULE-14, ADR-0038): a liaison links a mission (confirmation and a reason)
 * and gets an opaque reference and the enclave address; a second link
 * answers the same reference; other console readers see only "restricted";
 * a partner organization sees nothing; no wildcard grant links; body-camera
 * references and the retired enclave person role are refused; the database
 * accepts only an opaque reference. Runs only with API_DB_TEST_APP_URL and
 * API_DB_TEST_WORKER_URL.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { roleTemplates, type AccountSubject } from '@cg/authz';
import { FieldCrypto, InMemoryKeyService, MemoryKeyStore } from '@cg/crypto';
import { createDb, type Database } from '@cg/db';
import { sql, type Kysely } from 'kysely';
import { EXERCISE_CJI_REF, loadSeed } from '../../../tools/seed/src/load.ts';
import { buildApp, type App } from '../src/app.ts';
import { AuthError, type SubjectLoader } from '../src/auth/subject.ts';
import { routesWith } from '../src/routes/index.ts';

const appUrl = process.env['API_DB_TEST_APP_URL'];
const workerUrl = process.env['API_DB_TEST_WORKER_URL'];
const ENCLAVE = 'https://localhost:8443';

interface MissionBody {
  id: string;
  version: number;
  reference: string;
  cjis?: { restricted: true; ref?: string; url?: string; linkedAt?: string } | null;
  timeline?: { kind: string; detail: Record<string, unknown> }[];
}

describe.skipIf(!appUrl || !workerUrl)(
  'CJIS enclave link on the platform (database-backed)',
  () => {
    let app: App;
    let dbApp: Kysely<Database>;
    let dbWorker: Kysely<Database>;
    let tenants: Record<string, string>;
    let subjects: Record<string, AccountSubject>;
    let eventId: string;
    const crypto = new FieldCrypto(new InMemoryKeyService(), new MemoryKeyStore());

    beforeAll(async () => {
      dbApp = createDb(appUrl!, 3);
      dbWorker = createDb(workerUrl!, 2);
      const seeded = await loadSeed(dbWorker);
      tenants = seeded.tenants;
      const paths = Object.fromEntries(
        (
          await dbWorker
            .selectFrom('cg.tenant')
            .select(['id', 'path', 'kind'])
            .where('id', 'in', Object.values(tenants))
            .execute()
        ).map((t) => [t.id, t]),
      );
      eventId = (
        await dbWorker
          .selectFrom('cg.event')
          .select('id')
          .where('tenant_id', '=', tenants['county']!)
          .where('intake_slug', '=', 'westwind')
          .executeTakeFirstOrThrow()
      ).id;
      const subjectFor = (tenantKey: string, templateKey: string, accountId: string) => {
        const t = roleTemplates.find((r) => r.key === templateKey)!;
        const tenantId = tenants[tenantKey]!;
        return {
          kind: 'account' as const,
          accountId,
          tenantId,
          tenantPath: paths[tenantId]!.path,
          tenantKind: paths[tenantId]!.kind,
          status: 'active' as const,
          roles: [
            {
              roleId: randomUUID(),
              key: t.key,
              version: 1,
              templateKey: t.key,
              grants: t.grants,
              scope: { eventIds: [eventId] },
            },
          ],
          resolvedAt: new Date(),
        };
      };
      subjects = {
        liaison: subjectFor(
          'county',
          'law_enforcement_liaison',
          seeded.accounts['liaison@example.org']!,
        ),
        coordinator: subjectFor(
          'county',
          'field_coordinator',
          seeded.accounts['priya.assessment@example.org']!,
        ),
        admin: subjectFor('county', 'tenant_admin', seeded.accounts['admin@example.org']!),
        partner: subjectFor(
          'cleanup',
          'agency_dispatcher',
          seeded.accounts['admin.cleanup@example.org']!,
        ),
      };
      const loader: SubjectLoader = {
        async fromBearer(token) {
          const s = subjects[token];
          if (!s) throw new AuthError('invalid_token');
          return s;
        },
      };
      app = await buildApp({
        productName: 'Test Product',
        version: '0.0.0',
        dataMode: 'synthetic',
        logLevel: 'silent',
        probes: [],
        db: dbApp,
        fieldCrypto: crypto,
        subjects: loader,
        routes: routesWith({ missions: { cjisPublicUrl: ENCLAVE } }),
      });
    });

    afterAll(async () => {
      await app?.close();
      await dbApp?.destroy();
      await dbWorker?.destroy();
    });

    const call = async (
      who: string,
      method: 'GET' | 'POST',
      url: string,
      payload?: unknown,
      extra: Record<string, string> = {},
    ) => {
      const res = await app.inject({
        method,
        url,
        headers: { authorization: `Bearer ${who}`, 'idempotency-key': randomUUID(), ...extra },
        ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
      });
      return { status: res.statusCode, json: <T>() => res.json() as T };
    };
    const confirm = (reason: string) => ({ 'x-confirm': 'true', 'x-reason': reason });

    async function newMission(owningTenantId?: string): Promise<MissionBody> {
      const res = await call('coordinator', 'POST', '/api/v1/missions', {
        eventId,
        kind: 'other',
        source: 'staff',
        summary: 'Law-enforcement support at a damaged store (test)',
        save: 'draft',
        ...(owningTenantId ? { owningTenantId } : {}),
      });
      expect(res.status).toBe(201);
      return res.json<MissionBody>();
    }

    let linked: MissionBody;
    let ref = '';

    it('SEC-12: a liaison links a mission after confirming, and gets an opaque reference and the enclave address', async () => {
      linked = await newMission();
      const unconfirmed = await call('liaison', 'POST', `/api/v1/missions/${linked.id}/cji-link`);
      expect(unconfirmed.status).toBe(428);
      const res = await call(
        'liaison',
        'POST',
        `/api/v1/missions/${linked.id}/cji-link`,
        undefined,
        confirm('Deputies on scene'),
      );
      expect(res.status).toBe(200);
      const body = res.json<{ restricted: boolean; ref: string; url: string; linkedAt: string }>();
      expect(body.restricted).toBe(true);
      expect(body.ref).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(body.url).toBe(
        `${ENCLAVE}/records/${body.ref}?mission=${linked.reference}&county=county`,
      );
      ref = body.ref;
      const again = await call(
        'liaison',
        'POST',
        `/api/v1/missions/${linked.id}/cji-link`,
        undefined,
        confirm('Pressed twice'),
      );
      expect(again.json<{ ref: string }>().ref).toBe(ref);
      const audit = await dbWorker
        .selectFrom('cg.audit_event')
        .select(['action', 'reason'])
        .where('target_id', '=', linked.id)
        .where('action', '=', 'mission.cji.link')
        .execute();
      expect(audit).toHaveLength(1);
      expect(audit[0]?.reason).toContain('Deputies on scene');
    });

    it('the liaison sees the reference and the address on the mission; the read is audited', async () => {
      const res = await call('liaison', 'GET', `/api/v1/missions/${linked.id}`);
      expect(res.status).toBe(200);
      const m = res.json<MissionBody>();
      expect(m.cjis).toMatchObject({ restricted: true, ref, url: expect.stringContaining(ref) });
      expect(m.timeline?.some((e) => e.detail['cjis'] === 'linked')).toBe(true);
      const opened = await dbWorker
        .selectFrom('cg.audit_event')
        .select('action')
        .where('target_id', '=', linked.id)
        .where('action', '=', 'mission.cji.open')
        .execute();
      expect(opened.length).toBeGreaterThan(0);
    });

    it('other console readers see only that the details are restricted', async () => {
      const one = await call('coordinator', 'GET', `/api/v1/missions/${linked.id}`);
      expect(one.json<MissionBody>().cjis).toEqual({ restricted: true });
      const list = await call(
        'coordinator',
        'GET',
        `/api/v1/missions?eventId=${eventId}&limit=200`,
      );
      const row = list.json<MissionBody[]>().find((m) => m.id === linked.id);
      expect(row?.cjis).toEqual({ restricted: true });
      const plain = list.json<MissionBody[]>().find((m) => m.id !== linked.id && m.cjis === null);
      expect(plain).toBeDefined();
    });

    it('a partner organization sees nothing about the enclave, even on its own mission', async () => {
      const owned = await newMission(tenants['cleanup']!);
      await call(
        'liaison',
        'POST',
        `/api/v1/missions/${owned.id}/cji-link`,
        undefined,
        confirm('Partner-owned mission with deputies'),
      );
      const res = await call('partner', 'GET', `/api/v1/missions/${owned.id}`);
      expect(res.status).toBe(200);
      expect(res.json<MissionBody>().cjis).toBeUndefined();
      const denied = await call(
        'partner',
        'POST',
        `/api/v1/missions/${owned.id}/cji-link`,
        undefined,
        confirm('Partner tries'),
      );
      expect(denied.status).toBe(403);
    });

    it('ADM-05: no wildcard links; a coordinator and the tenant administrator cannot', async () => {
      const m = await newMission();
      for (const who of ['coordinator', 'admin']) {
        const res = await call(
          who,
          'POST',
          `/api/v1/missions/${m.id}/cji-link`,
          undefined,
          confirm('Trying'),
        );
        expect(res.status).toBe(404);
      }
      const admin = await call('admin', 'GET', `/api/v1/missions/${linked.id}`);
      expect(admin.json<MissionBody>().cjis).toEqual({ restricted: true });
    });

    it('BRD:FR-07.04: body-camera references are refused on the platform', async () => {
      const res = await call('coordinator', 'POST', `/api/v1/missions/${linked.id}/media`, {
        kind: 'bodycam_reference',
        description: 'Camera 7',
      });
      expect(res.status).toBe(422);
      expect(res.json<{ code: string }>().code).toBe('cji_in_enclave');
    });

    it('PPL-01: law-enforcement people are not recorded on the platform', async () => {
      const res = await call('coordinator', 'POST', `/api/v1/missions/${linked.id}/people`, {
        role: 'enclave_reference',
      });
      expect(res.status).toBe(400);
      const suspect = await call('coordinator', 'POST', `/api/v1/missions/${linked.id}/people`, {
        role: 'suspect',
      });
      expect(suspect.status).toBe(400);
    });

    it('the database accepts only an opaque reference, and the exercise mission carries the fixed one', async () => {
      await expect(
        sql`update cg.mission set cji_ref = 'M-00012', cji_linked_at = now()
          where id = ${linked.id}::uuid`.execute(dbWorker),
      ).rejects.toThrow(/mission_cji_ref_opaque/);
      const exercise = await dbWorker
        .selectFrom('cg.mission')
        .select(['cji_ref', 'summary'])
        .where('cji_ref', '=', EXERCISE_CJI_REF)
        .executeTakeFirst();
      expect(exercise?.summary).not.toMatch(/suspect|arrest|weapon/i);
    });
  },
);
