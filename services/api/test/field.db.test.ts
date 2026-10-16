/**
 * The field roster API and the worker's safety clock against a real
 * PostgreSQL (layer-4 task D; PER-01, PER-02, BRD:FR-05.02–05.06, AC-05A/B,
 * DSP-01, DSP-02, DSP-04, DSP-05, DSP-07, DSP-08, DSP-09, FLD-02, FLD-03,
 * FLD-14, FLD-16, FL-17, RULE-03, SEC-13, SEC-18): a skill search answers
 * only from recorded credentials in force; a revoked credential leaves the
 * skills list; a volunteer checks in by event code with the credentials in
 * force snapshotted, the team goes available, positions are accepted while
 * checked in and refused after check-out, dispatch sees the latest position
 * at the tenant's precision and a volunteer not at all; the check-in timer
 * turns a silent team overdue and raises one alert, "we're OK" clears it;
 * an unacknowledged dispatch raises an alert after the window; a help alert
 * carries the exact position and is idempotent by client id; acknowledging
 * needs the version; escalation emails the safety officers once; a remote
 * wipe ends the shift; old position days drop and are logged per tenant.
 * Runs only with API_DB_TEST_APP_URL and API_DB_TEST_WORKER_URL.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SimulatorSms } from '@cg/adapters';
import { fakeProvider } from '@cg/ai';
import { roleTemplates, type AccountSubject } from '@cg/authz';
import { FieldCrypto, InMemoryKeyService, MemoryKeyStore } from '@cg/crypto';
import { recordAudit } from '@cg/audit';
import { createDb, withTenant, type Database } from '@cg/db';
import { westwindGraph } from '@cg/intake';
import { sql, type Kysely } from 'kysely';
import { loadSeed } from '../../../tools/seed/src/load.ts';
import type { KeycloakAdmin } from '../../worker/src/idp/keycloak.ts';
import { dropPositionTrails, watchFieldSafety } from '../../worker/src/jobs/field.ts';
import type { JobContext } from '../../worker/src/jobs/types.ts';
import { buildApp, type App } from '../src/app.ts';
import { AuthError, type SubjectLoader } from '../src/auth/subject.ts';
import { RiskScorer } from '../src/public/abuse.ts';
import { ReferenceCodeLeaser } from '../src/public/reference-codes.ts';
import { publicRoutes } from '../src/public/routes.ts';
import { submitIntake } from '../src/public/submit.ts';
import { TenantResolver } from '../src/public/tenant-resolver.ts';
import { routes } from '../src/routes/index.ts';

const appUrl = process.env['API_DB_TEST_APP_URL'];
const workerUrl = process.env['API_DB_TEST_WORKER_URL'];

interface Team {
  id: string;
  version: number;
  key: string;
  current: { status: string; source: string } | null;
  checkedInCount: number;
  checkInDueAt: string | null;
  members?: { personnelId: string; role: string; checkedIn: boolean; credentials: string[] }[];
}
interface CheckIn {
  id: string;
  teamId: string | null;
  credentials: { kind: string; status: string }[];
  endedAt: string | null;
  hours: number | null;
}
interface Alert {
  id: string;
  version: number;
  kind: string;
  state: string;
  teamId: string | null;
  position: { lat: number; lon: number } | null;
}
interface Position {
  personnelId: string;
  lat: number;
  lon: number;
  precisionM: number;
  stale: boolean;
}

describe.skipIf(!appUrl || !workerUrl)(
  'field roster API and safety clock (database-backed)',
  () => {
    let app: App;
    let dbApp: Kysely<Database>;
    let dbWorker: Kysely<Database>;
    let tenants: Record<string, string>;
    let subjects: Record<string, AccountSubject>;
    let eventId: string;
    let worker: JobContext;
    let clock = Date.now();
    const mails: { to: string; subject: string }[] = [];
    const crypto = new FieldCrypto(new InMemoryKeyService(), new MemoryKeyStore());
    const headers = (who: string, extra: Record<string, string> = {}) => ({
      authorization: `Bearer ${who}`,
      ...extra,
    });
    const confirmed = (reason: string, version?: number) => ({
      'x-confirm': 'true',
      'x-reason': reason,
      ...(version !== undefined ? { 'if-match': String(version) } : {}),
    });
    const call = async (
      who: string,
      method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
      url: string,
      payload?: unknown,
      extra: Record<string, string> = {},
    ) => {
      const res = await app.inject({
        method,
        url,
        headers: headers(who, extra),
        ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
      });
      return { status: res.statusCode, body: res.body, json: <T>() => res.json() as T };
    };

    let volunteerPersonnelId: string;
    let leadPersonnelId: string;
    let teamId: string;
    let checkIn: CheckIn;

    beforeAll(async () => {
      dbApp = createDb(appUrl!, 3);
      dbWorker = createDb(workerUrl!, 2);
      const seeded = await loadSeed(dbWorker);
      tenants = seeded.tenants;
      const county = tenants['county']!;
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
          .where('tenant_id', '=', county)
          .where('intake_slug', '=', 'westwind')
          .executeTakeFirstOrThrow()
      ).id;
      // The CERT canvass team: its lead and one member get accounts for the field app.
      const team = await dbWorker
        .selectFrom('cg.team')
        .select(['id', 'lead_personnel_id'])
        .where('tenant_id', '=', county)
        .where('key', '=', 'cert-canvass')
        .executeTakeFirstOrThrow();
      teamId = team.id;
      leadPersonnelId = team.lead_personnel_id!;
      const member = await dbWorker
        .selectFrom('cg.team_member')
        .select('personnel_id')
        .where('team_id', '=', teamId)
        .where('role', '=', 'member')
        .orderBy('joined_at')
        .executeTakeFirstOrThrow();
      volunteerPersonnelId = member.personnel_id;
      const ensureAccount = async (email: string, personnelId: string) => {
        const existing = await dbWorker
          .selectFrom('cg.account')
          .select('id')
          .where('tenant_id', '=', county)
          .where('email', '=', email)
          .executeTakeFirst();
        const id =
          existing?.id ??
          (
            await dbWorker
              .insertInto('cg.account')
              .values({
                tenant_id: county,
                email,
                display_name: email,
                status: 'active',
                activated_at: new Date(),
              })
              .returning('id')
              .executeTakeFirstOrThrow()
          ).id;
        await dbWorker
          .updateTable('cg.personnel')
          .set({ account_id: id })
          .where('id', '=', personnelId)
          .execute();
        return id;
      };
      const volunteerAccount = await ensureAccount(
        'field.volunteer@example.org',
        volunteerPersonnelId,
      );
      const leadAccount = await ensureAccount('field.lead@example.org', leadPersonnelId);
      const subjectFor = (
        tenantKey: string,
        templateKey: string,
        accountId: string,
      ): AccountSubject => {
        const t = roleTemplates.find((r) => r.key === templateKey)!;
        const tenantId = tenants[tenantKey]!;
        return {
          kind: 'account',
          accountId,
          tenantId,
          tenantPath: paths[tenantId]!.path,
          tenantKind: paths[tenantId]!.kind,
          status: 'active',
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
        priya: subjectFor(
          'county',
          'field_coordinator',
          seeded.accounts['priya.assessment@example.org']!,
        ),
        admin: subjectFor('county', 'tenant_admin', seeded.accounts['admin@example.org']!),
        safety: subjectFor('county', 'safety_officer', randomUUID()),
        coordinator: subjectFor('county', 'personnel_coordinator', randomUUID()),
        volunteer: subjectFor('county', 'field_volunteer', volunteerAccount),
        lead: subjectFor('county', 'team_lead', leadAccount),
        saw: subjectFor(
          'cleanup',
          'agency_dispatcher',
          seeded.accounts['admin.cleanup@example.org']!,
        ),
        pio: subjectFor(
          'county',
          'public_information_officer',
          seeded.accounts['tomas.pio@example.org']!,
        ),
      };
      const loader: SubjectLoader = {
        async fromBearer(token) {
          const s = subjects[token];
          if (!s) throw new AuthError('invalid_token');
          return s;
        },
      };
      const resolver = new TenantResolver(dbApp);
      const codes = new ReferenceCodeLeaser(dbApp, 'test');
      const risk = new RiskScorer();
      const submitDeps = {
        codes,
        risk,
        getQueue: () => undefined,
        defaultGraph: westwindGraph,
        crypto,
        now: () => new Date(),
      };
      const ai = { providerFor: async () => fakeProvider };
      app = await buildApp({
        productName: 'Test Product',
        version: '0.0.0',
        dataMode: 'synthetic',
        logLevel: 'silent',
        probes: [],
        db: dbApp,
        fieldCrypto: crypto,
        subjects: loader,
        routes,
        reportDeps: { ai, submit: (req, input) => submitIntake(submitDeps, req, input) },
        publicRoutes: [
          publicRoutes({
            resolver,
            codes,
            risk,
            getQueue: () => undefined,
            residentTokenSecret: 'test-secret-'.repeat(4),
            defaultGraph: westwindGraph,
            ai,
          }),
        ],
      });
      worker = {
        db: dbWorker,
        log: { info() {}, warn() {}, error() {}, debug() {} } as unknown as JobContext['log'],
        idp: {} as unknown as KeycloakAdmin,
        mail: { send: async (m) => void mails.push(m) },
        sms: new SimulatorSms(),
        crypto,
        urls: { gatewayPublic: 'https://localhost', idpPublic: '', idpInternal: '' },
        objects: null,
        devDirectGrant: false,
        ai,
        defaultGraph: westwindGraph,
        now: () => new Date(clock),
      };
      // A clean slate for the team this file drives: earlier local runs may have left shifts and alerts.
      await dbWorker
        .updateTable('cg.check_in')
        .set({ ended_at: new Date(), end_reason: 'shift_end' })
        .where('team_id', '=', teamId)
        .where('ended_at', 'is', null)
        .execute();
      await dbWorker
        .updateTable('cg.assignment')
        .set({ state: 'released', released_at: new Date(), release_reason: 'test reset' })
        .where('team_id', '=', teamId)
        .where('released_at', 'is', null)
        .execute();
      await dbWorker
        .updateTable('cg.safety_alert')
        .set({ state: 'resolved', resolved_at: new Date(), resolution: 'test reset' })
        .where('team_id', '=', teamId)
        .where('state', 'in', ['open', 'acknowledged', 'escalated'])
        .execute();
    });

    afterAll(async () => {
      await app?.close();
      await dbApp?.destroy();
      await dbWorker?.destroy();
    });

    it('AC-05A: a skill search answers only from recorded credentials in force; a revoked credential leaves the skills list (PER-01, FR-05.06)', async () => {
      const chainsaw = await call('priya', 'GET', '/api/v1/personnel/search?skill=chainsaw');
      expect(chainsaw.status, chainsaw.body).toBe(200);
      const people = chainsaw.json<{ id: string; tenantId: string; credentials: string[] }[]>();
      expect(people.length).toBeGreaterThanOrEqual(9); // the two saw crews of the cleanup partner, visible to the county (DSP-09)
      expect(people.every((p) => p.credentials.includes('chainsaw'))).toBe(true);
      expect(people.every((p) => p.tenantId === tenants['cleanup'])).toBe(true);
      // The partner's dispatcher sees its own people; the PIO sees nobody.
      const partnerView = await call('saw', 'GET', '/api/v1/personnel/search?skill=chainsaw');
      expect(partnerView.status).toBe(200);
      expect(partnerView.json<unknown[]>().length).toBe(people.length);
      expect((await call('pio', 'GET', '/api/v1/personnel/search?skill=chainsaw')).status).toBe(
        403,
      );
      // Record, verify and revoke on the volunteer: the skills column follows the credentials.
      const recorded = await call(
        'coordinator',
        'POST',
        `/api/v1/personnel/${volunteerPersonnelId}/credentials`,
        { kind: 'chainsaw', issuer: 'Exercise', issuedAt: '2026-10-01' },
      );
      expect(recorded.status, recorded.body).toBe(201);
      const cred = recorded.json<{
        id: string;
        version: number;
        status: string;
        inForce: boolean;
      }>();
      expect(cred.status).toBe('recorded');
      expect(cred.inForce).toBe(false); // recorded, not yet verified: not in force for assignments
      const unverifiedSearch = (
        await call('priya', 'GET', '/api/v1/personnel/search?skill=chainsaw')
      ).json<{ id: string }[]>();
      expect(unverifiedSearch.some((p) => p.id === volunteerPersonnelId)).toBe(false);
      const verified = await call(
        'coordinator',
        'POST',
        `/api/v1/credentials/${cred.id}/verify`,
        { expiresAt: '2028-01-01' },
        { 'if-match': String(cred.version) },
      );
      expect(verified.status, verified.body).toBe(200);
      expect(verified.json<{ inForce: boolean }>().inForce).toBe(true);
      const nowFound = (await call('priya', 'GET', '/api/v1/personnel/search?skill=chainsaw')).json<
        { id: string }[]
      >();
      expect(nowFound.some((p) => p.id === volunteerPersonnelId)).toBe(true);
      const revoked = await call(
        'coordinator',
        'POST',
        `/api/v1/credentials/${cred.id}/revoke`,
        undefined,
        confirmed('Card reported lost', verified.json<{ version: number }>().version),
      );
      expect(revoked.status, revoked.body).toBe(200);
      const skills = await dbWorker
        .selectFrom('cg.personnel')
        .select('skills')
        .where('id', '=', volunteerPersonnelId)
        .executeTakeFirstOrThrow();
      expect(skills.skills).not.toContain('chainsaw');
      // A volunteer cannot record a credential for themself (FR-05.04).
      expect(
        (
          await call('volunteer', 'POST', `/api/v1/personnel/${volunteerPersonnelId}/credentials`, {
            kind: 'medical',
          })
        ).status,
      ).toBe(404);
    });

    it('FLD-03: check-in by event code snapshots the credentials in force, puts the team on the board; a second check-in is refused; positions flow only while checked in (DSP-08)', async () => {
      const wrongCode = await call('volunteer', 'POST', '/api/v1/check-ins', { eventCode: 'NOPE' });
      expect(wrongCode.status).toBe(400);
      const res = await call('volunteer', 'POST', '/api/v1/check-ins', {
        eventCode: 'westwind',
        teamId,
      });
      expect(res.status, res.body).toBe(201);
      checkIn = res.json<CheckIn>();
      expect(checkIn.teamId).toBe(teamId);
      expect(checkIn.credentials.map((c) => c.kind)).toEqual(
        expect.arrayContaining(['cert', 'background_check']),
      );
      const again = await call('volunteer', 'POST', '/api/v1/check-ins', { eventCode: 'WESTWIND' });
      expect(again.status).toBe(409);
      const team = (await call('priya', 'GET', `/api/v1/teams/${teamId}`)).json<Team>();
      expect(team.current?.status).toBe('available');
      expect(team.checkedInCount).toBe(1);
      expect(team.checkInDueAt).not.toBeNull();
      expect(team.members!.find((m) => m.personnelId === volunteerPersonnelId)?.checkedIn).toBe(
        true,
      );
      const mine = (await call('volunteer', 'GET', '/api/v1/check-ins?mine=true')).json<
        CheckIn[]
      >();
      expect(mine[0]!.id).toBe(checkIn.id);
      // Positions: a batch with a 0,0 fix refused, the rest accepted; dispatch sees the latest, the volunteer sees nothing.
      const batch = await call('volunteer', 'POST', '/api/v1/positions', {
        positions: [
          {
            lat: 38.7905,
            lon: -90.9051,
            accuracyM: 6,
            recordedAt: new Date(Date.now() - 60_000).toISOString(),
          },
          { lat: 38.7906, lon: -90.9052, accuracyM: 5, recordedAt: new Date().toISOString() },
          { lat: 0, lon: 0, recordedAt: new Date().toISOString() },
        ],
      });
      expect(batch.status, batch.body).toBe(202);
      expect(batch.json<{ accepted: number; rejected: number }>()).toMatchObject({
        accepted: 2,
        rejected: 1,
      });
      const latest = await call('priya', 'GET', `/api/v1/positions/latest?eventId=${eventId}`);
      expect(latest.status, latest.body).toBe(200);
      const mineOnMap = latest
        .json<Position[]>()
        .find((p) => p.personnelId === volunteerPersonnelId)!;
      expect(mineOnMap.lat).toBeCloseTo(38.7906, 4);
      expect(mineOnMap.precisionM).toBe(0);
      expect(mineOnMap.stale).toBe(false);
      expect(
        (await call('volunteer', 'GET', `/api/v1/positions/latest?eventId=${eventId}`)).status,
      ).toBe(403);
      expect(
        (await call('lead', 'GET', `/api/v1/positions/latest?eventId=${eventId}`)).status,
      ).toBe(403);
      // The tenant's precision rounds the map for dispatch roles (DSP-08); the setting is configuration.
      await dbWorker
        .insertInto('cg.tenant_config')
        .values({
          tenant_id: tenants['county']!,
          key: 'field.position_precision_m',
          value: JSON.stringify(100),
        } as never)
        .onConflict((oc) =>
          oc.columns(['tenant_id', 'key']).doUpdateSet({ value: JSON.stringify(100) } as never),
        )
        .execute();
      const rounded = (await call('safety', 'GET', `/api/v1/positions/latest?eventId=${eventId}`))
        .json<Position[]>()
        .find((p) => p.personnelId === volunteerPersonnelId)!;
      expect(rounded.precisionM).toBe(100);
      expect(Math.abs(rounded.lat - 38.7906)).toBeLessThan(0.001);
      expect(rounded.lat).not.toBe(mineOnMap.lat);
      await dbWorker
        .deleteFrom('cg.tenant_config')
        .where('tenant_id', '=', tenants['county']!)
        .where('key', '=', 'field.position_precision_m')
        .execute();
    });

    it('FLD-03: a coordinator sets or replaces the staging check-in code of an event; a replaced code stops working at once; codes are unique in the county; a role without the grant cannot', async () => {
      const county = tenants['county']!;
      const staging = (
        await dbWorker
          .insertInto('cg.event')
          .values({
            tenant_id: county,
            name: `Exercise staging ${randomUUID().slice(0, 8)}`,
            hazard_type: 'flood',
            status: 'active',
            opened_at: new Date(),
          })
          .returning('id')
          .executeTakeFirstOrThrow()
      ).id;
      const version = async () =>
        (await call('priya', 'GET', `/api/v1/events/${staging}`)).json<{
          version: number;
          checkInCode: string | null;
        }>();
      expect((await version()).checkInCode).toBeNull();
      const setCode = (who: string, body: Record<string, unknown>, v: number) =>
        call(who, 'POST', `/api/v1/events/${staging}/check-in-code`, body, {
          'if-match': String(v),
        });
      // Letters and digits only; another event's code is refused.
      expect((await setCode('priya', { code: 'stage-42' }, (await version()).version)).status).toBe(
        400,
      );
      const clash = await setCode('priya', { code: 'westwind' }, (await version()).version);
      expect(clash.status).toBe(400);
      expect(clash.body).toContain('another event uses this code');
      // A role without the grant: the event answers as not found.
      expect((await setCode('pio', {}, (await version()).version)).status).toBe(404);

      const typed = await setCode('priya', { code: 'Stage42' }, (await version()).version);
      expect(typed.status, typed.body).toBe(200);
      expect(typed.json<{ checkInCode: string }>().checkInCode).toBe('STAGE42');
      // The code is recognised however it is typed (this volunteer is already checked in elsewhere).
      expect(
        (await call('volunteer', 'POST', '/api/v1/check-ins', { eventCode: 'stage42' })).status,
      ).toBe(409);

      // A new code, made without typing one: six letters and digits that cannot be confused.
      const fresh = await setCode('coordinator', {}, (await version()).version);
      expect(fresh.status, fresh.body).toBe(200);
      const made = fresh.json<{ checkInCode: string }>().checkInCode;
      expect(made).toMatch(/^[ACDEFHJKMNPRTUVWXY3479]{6}$/);
      // The replaced code no longer finds the event; the new one does.
      const retired = await call('volunteer', 'POST', '/api/v1/check-ins', {
        eventCode: 'STAGE42',
      });
      expect(retired.status).toBe(400);
      expect(
        (await call('volunteer', 'POST', '/api/v1/check-ins', { eventCode: made })).status,
      ).toBe(409);
      // A stale version is refused; a closed event keeps its code.
      expect((await setCode('priya', {}, 1)).status).toBe(409);
      await dbWorker
        .updateTable('cg.event')
        .set({ status: 'closed', closed_at: new Date(), close_reason: 'Exercise over' })
        .where('id', '=', staging)
        .execute();
      expect((await setCode('priya', {}, (await version()).version)).status).toBe(409);
      const trail = await dbWorker
        .selectFrom('cg.audit_event')
        .select(['changes', 'actor_account_id'])
        .where('tenant_id', '=', county)
        .where('action', '=', 'event.check_in_code')
        .where('target_id', '=', staging)
        .orderBy('seq')
        .execute();
      expect(trail.map((a) => JSON.stringify(a.changes))).toEqual([
        expect.stringContaining('"set"'),
        expect.stringContaining('"replaced"'),
      ]);
      // The code itself never goes into the audit record.
      expect(JSON.stringify(trail)).not.toContain(made);
      expect(JSON.stringify(trail)).not.toContain('STAGE42');
    });

    it('DSP-07: a silent team turns overdue once and raises one alert; "we are OK" clears it; an unacknowledged dispatch alerts after the window (DSP-04)', async () => {
      // Nothing yet: the team checked in moments ago.
      await watchFieldSafety(worker);
      let alerts = (await call('priya', 'GET', '/api/v1/safety-alerts?open=true'))
        .json<Alert[]>()
        .filter((a) => a.teamId === teamId);
      expect(alerts).toHaveLength(0);
      // 61 minutes later (the CERT team's interval is 60), twice: one overdue status, one alert.
      clock = Date.now() + 61 * 60_000;
      await watchFieldSafety(worker);
      await watchFieldSafety(worker);
      const team = (await call('priya', 'GET', `/api/v1/teams/${teamId}`)).json<Team>();
      expect(team.current?.status).toBe('overdue');
      expect(team.current?.source).toBe('timer');
      alerts = (await call('priya', 'GET', '/api/v1/safety-alerts?open=true'))
        .json<Alert[]>()
        .filter((a) => a.teamId === teamId && a.kind === 'missed_check_in');
      expect(alerts).toHaveLength(1);
      // The lead answers the timer from the app: the team is available again and the alert resolved.
      const ok = await call('lead', 'POST', `/api/v1/teams/${teamId}/status`, {
        status: 'on_task',
        source: 'app',
        note: 'All well, block 3',
      });
      expect(ok.status, ok.body).toBe(200);
      expect(ok.json<Team>().current?.status).toBe('on_task');
      const after = (await call('priya', 'GET', '/api/v1/safety-alerts?open=true'))
        .json<Alert[]>()
        .filter((a) => a.teamId === teamId && a.kind === 'missed_check_in');
      expect(after).toHaveLength(0);
      // A suggested status from location is recorded, not applied (DSP-05).
      const suggested = await call('lead', 'POST', `/api/v1/teams/${teamId}/status`, {
        status: 'break',
        suggested: true,
        source: 'app',
      });
      expect(suggested.json<Team>().current?.status).toBe('on_task');
      // Dispatch the team to the seeded traffic mission's twin: a new mission, dispatched by app, nobody acknowledges.
      const mission = await call(
        'priya',
        'POST',
        '/api/v1/missions',
        {
          eventId,
          kind: 'outreach_sweep',
          source: 'staff',
          summary: 'Door hangers, Willow Bend rows 1–4',
          location: { landmark: 'Willow Bend office', state: 'manual' },
        },
        { 'idempotency-key': randomUUID() },
      );
      expect(mission.status, mission.body).toBe(201);
      const m = mission.json<{ id: string }>();
      const assigned = await call(
        'priya',
        'POST',
        `/api/v1/missions/${m.id}/assignments`,
        { resources: [{ kind: 'team', id: teamId }], dispatch: { method: 'app' } },
        { 'idempotency-key': randomUUID() },
      );
      expect(assigned.status, assigned.body).toBe(201);
      clock = clock + 11 * 60_000;
      await watchFieldSafety(worker);
      const unacked = (await call('priya', 'GET', '/api/v1/safety-alerts?open=true'))
        .json<Alert[]>()
        .filter((a) => a.kind === 'unacknowledged_assignment' && a.teamId === teamId);
      expect(unacked).toHaveLength(1);
      await watchFieldSafety(worker);
      expect(
        (await call('priya', 'GET', '/api/v1/safety-alerts?open=true'))
          .json<Alert[]>()
          .filter((a) => a.kind === 'unacknowledged_assignment' && a.teamId === teamId),
      ).toHaveLength(1);
      const activity = await dbWorker
        .selectFrom('cg.activity_entry')
        .select('kind')
        .where('team_id', '=', teamId)
        .execute();
      expect(activity.map((a) => a.kind)).toEqual(
        expect.arrayContaining(['check_in', 'alert', 'status', 'dispatched']),
      );
    });

    it('FLD-16: the help button carries the exact position whatever the precision, is idempotent by client id, needs acknowledgement, and escalates by email once (DSP-07)', async () => {
      await dbWorker
        .insertInto('cg.tenant_config')
        .values({
          tenant_id: tenants['county']!,
          key: 'field.position_precision_m',
          value: JSON.stringify(500),
        } as never)
        .onConflict((oc) =>
          oc.columns(['tenant_id', 'key']).doUpdateSet({ value: JSON.stringify(500) } as never),
        )
        .execute();
      const clientUuid = randomUUID();
      const raised = await call('volunteer', 'POST', '/api/v1/safety-alerts', {
        clientUuid,
        position: { lat: 38.79061, lon: -90.90521, accuracyM: 4 },
        note: 'Aggressive dog, cannot leave the yard',
      });
      expect(raised.status, raised.body).toBe(201);
      const alert = raised.json<Alert>();
      expect(alert.kind).toBe('help_button');
      expect(alert.position?.lat).toBeCloseTo(38.79061, 5);
      const resent = await call('volunteer', 'POST', '/api/v1/safety-alerts', {
        clientUuid,
        position: { lat: 38.79061, lon: -90.90521 },
      });
      expect(resent.status).toBe(200);
      expect(resent.json<Alert>().id).toBe(alert.id);
      // Dispatch sees the exact point even with a 500 m precision for the map (plan §12.1).
      const seen = (await call('priya', 'GET', '/api/v1/safety-alerts?open=true'))
        .json<Alert[]>()
        .find((a) => a.id === alert.id)!;
      expect(seen.position?.lon).toBeCloseTo(-90.90521, 5);
      await dbWorker
        .deleteFrom('cg.tenant_config')
        .where('tenant_id', '=', tenants['county']!)
        .where('key', '=', 'field.position_precision_m')
        .execute();
      // Nobody acknowledges within 15 minutes: escalation emails the safety officers once.
      const before = mails.length;
      clock = clock + 16 * 60_000;
      await watchFieldSafety(worker);
      const escalated = (await call('safety', 'GET', `/api/v1/safety-alerts?open=true`))
        .json<Alert[]>()
        .find((a) => a.id === alert.id)!;
      expect(escalated.state).toBe('escalated');
      const notices = await dbWorker
        .selectFrom('cg.outbox')
        .select('payload')
        .where('tenant_id', '=', tenants['county']!)
        .where('topic', '=', 'message.send')
        .execute();
      const mine = notices.filter((n) => (n.payload as { alertId?: string }).alertId === alert.id);
      expect(mine.length).toBeGreaterThanOrEqual(1);
      expect((mine[0]!.payload as { template: string }).template).toBe('help_alert');
      await watchFieldSafety(worker);
      const again = (
        await dbWorker
          .selectFrom('cg.outbox')
          .select('payload')
          .where('tenant_id', '=', tenants['county']!)
          .where('topic', '=', 'message.send')
          .execute()
      ).filter((n) => (n.payload as { alertId?: string }).alertId === alert.id);
      expect(again.length).toBe(mine.length); // escalated once
      expect(mails.length).toBe(before); // the worker's mail goes through the message job, not from here
      // A stale version is refused; acknowledging with the current one works; the volunteer cannot acknowledge.
      expect(
        (
          await call(
            'safety',
            'POST',
            `/api/v1/safety-alerts/${alert.id}/acknowledge`,
            {},
            { 'if-match': '1' },
          )
        ).status,
      ).toBe(409);
      expect(
        (
          await call(
            'volunteer',
            'POST',
            `/api/v1/safety-alerts/${alert.id}/acknowledge`,
            {},
            { 'if-match': String(escalated.version) },
          )
        ).status,
      ).toBe(404);
      const acked = await call(
        'safety',
        'POST',
        `/api/v1/safety-alerts/${alert.id}/acknowledge`,
        {},
        { 'if-match': String(escalated.version) },
      );
      expect(acked.status, acked.body).toBe(200);
      expect(acked.json<Alert>().state).toBe('acknowledged');
      const resolved = await call(
        'safety',
        'POST',
        `/api/v1/safety-alerts/${alert.id}/resolve`,
        { resolution: 'Animal control on scene; volunteer safe' },
        confirmed('Spoke with the volunteer', acked.json<Alert>().version),
      );
      expect(resolved.status, resolved.body).toBe(200);
      expect(resolved.json<Alert>().state).toBe('resolved');
    });

    it('DSP-07: an alert acknowledged while the timer escalates it stays acknowledged; nobody is emailed for it', async () => {
      const raised = await call('volunteer', 'POST', '/api/v1/safety-alerts', {
        clientUuid: randomUUID(),
        position: { lat: 38.7907, lon: -90.9052, accuracyM: 5 },
        note: 'Exercise: acknowledged as the timer runs',
      });
      expect(raised.status, raised.body).toBe(201);
      const alert = raised.json<Alert>();
      clock = Math.max(clock, Date.now()) + 16 * 60_000;
      // A safety officer acknowledges: the row is theirs until they commit, and they audit last.
      let go!: () => void;
      const released = new Promise<void>((r) => (go = r));
      let locked!: () => void;
      const holding = new Promise<void>((r) => (locked = r));
      const officer = withTenant(dbWorker, { tenantId: tenants['county']! }, async (trx) => {
        await trx
          .updateTable('cg.safety_alert')
          .set({
            state: 'acknowledged',
            acknowledged_at: new Date(),
            acknowledged_by: randomUUID(),
          })
          .where('id', '=', alert.id)
          .execute();
        locked();
        await released;
        await recordAudit(trx, {
          tenantId: tenants['county']!,
          actorKind: 'account',
          action: 'safety_alert.acknowledge',
          targetType: 'safety_alert',
          targetId: alert.id,
        });
      });
      await holding;
      // The timer read the alert as open and now waits on the officer's row
      // (both hold the worker pool's two connections; the check uses the other pool).
      const timer = watchFieldSafety(worker);
      try {
        for (let i = 0; ; i++) {
          const { rows } = await sql<{
            n: number;
          }>`select count(*)::int as n from pg_locks where not granted`.execute(dbApp);
          if (rows[0]!.n > 0) break;
          if (i > 1200) throw new Error('the timer never waited on the acknowledged alert');
          await new Promise((r) => setTimeout(r, 25));
        }
      } finally {
        go();
      }
      await Promise.all([officer, timer]);
      const row = await dbWorker
        .selectFrom('cg.safety_alert')
        .select(['state', 'escalated_at'])
        .where('id', '=', alert.id)
        .executeTakeFirstOrThrow();
      expect(row).toEqual({ state: 'acknowledged', escalated_at: null });
      const notices = (
        await dbWorker
          .selectFrom('cg.outbox')
          .select('payload')
          .where('tenant_id', '=', tenants['county']!)
          .where('topic', '=', 'message.send')
          .execute()
      ).filter((n) => (n.payload as { alertId?: string }).alertId === alert.id);
      expect(notices).toEqual([]);
    }, 60_000);

    it('FLD-02 / FLD-14: a registered device can be wiped remotely, which ends the shift and stops positions; check-out counts the hours (FL-17)', async () => {
      const device = await call('volunteer', 'POST', '/api/v1/devices', {
        installId: `install-${randomUUID()}`,
        platform: 'android',
        managed: false,
        model: 'Pixel 7',
      });
      expect(device.status, device.body).toBe(201);
      const d = device.json<{ id: string; wipeRequired: boolean }>();
      expect(d.wipeRequired).toBe(false);
      const asAdmin = await call('priya', 'GET', '/api/v1/devices');
      expect(asAdmin.status).toBe(200);
      // Another volunteer's position batch with this device keeps last contact; then the wipe.
      // The coordinator cannot wipe (device.wipe is an administrator's action, hidden as 404); the administrator needs a confirmed reason.
      expect((await call('priya', 'POST', `/api/v1/devices/${d.id}/wipe`, {})).status).toBe(404);
      const noConfirm = await call('admin', 'POST', `/api/v1/devices/${d.id}/wipe`, {});
      expect(noConfirm.status).toBe(428);
      const wiped = await call(
        'admin',
        'POST',
        `/api/v1/devices/${d.id}/wipe`,
        {},
        confirmed('Phone reported lost at the staging area'),
      );
      expect(wiped.status, wiped.body).toBe(200);
      expect(wiped.json<{ wipeRequired: boolean; status: string }>()).toMatchObject({
        wipeRequired: true,
        status: 'wipe_requested',
      });
      const confirmedWipe = await call('volunteer', 'POST', `/api/v1/devices/${d.id}/confirm`, {
        wiped: true,
      });
      expect(confirmedWipe.json<{ status: string }>().status).toBe('wiped');
      // The shift is still the volunteer's own (the device was not linked to it); check out and count hours.
      const ended = await call('volunteer', 'POST', `/api/v1/check-ins/${checkIn.id}/end`, {
        reason: 'checked_out',
      });
      expect(ended.status, ended.body).toBe(200);
      expect(ended.json<CheckIn>().endedAt).not.toBeNull();
      expect(ended.json<CheckIn>().hours).not.toBeNull();
      const refused = await call('volunteer', 'POST', '/api/v1/positions', {
        positions: [{ lat: 38.79, lon: -90.9, recordedAt: new Date().toISOString() }],
      });
      expect(refused.status).toBe(409);
      expect(refused.json<{ code: string }>().code).toBe('not_checked_in');
      const team = (await call('priya', 'GET', `/api/v1/teams/${teamId}`)).json<Team>();
      expect(team.checkedInCount).toBe(0);
      expect(team.current?.status).toBe('out_of_service');
    });

    it('SEC-13 / DSP-08: position days older than the trail period drop whole and the deletion is logged per tenant', async () => {
      const county = tenants['county']!;
      const old = new Date(Date.now() - 45 * 86_400_000);
      await dbWorker
        .insertInto('cg.position')
        .values({
          tenant_id: county,
          check_in_id: checkIn.id,
          personnel_id: volunteerPersonnelId,
          team_id: teamId,
          geom: sql`ST_SetSRID(ST_MakePoint(-90.9, 38.79), 4326)`,
          source: 'app',
          recorded_at: old,
        })
        .execute()
        .catch(async (err: Error) => {
          if (!/no partition/.test(err.message)) throw err;
          await sql`select cg.ensure_position_partition(${old.toISOString().slice(0, 10)}::date)`.execute(
            dbWorker,
          );
          await dbWorker
            .insertInto('cg.position')
            .values({
              tenant_id: county,
              check_in_id: checkIn.id,
              personnel_id: volunteerPersonnelId,
              team_id: teamId,
              geom: sql`ST_SetSRID(ST_MakePoint(-90.9, 38.79), 4326)`,
              source: 'app',
              recorded_at: old,
            })
            .execute();
        });
      const logsBefore = await dbWorker
        .selectFrom('cg.deletion_log')
        .select('id')
        .where('tenant_id', '=', county)
        .where('data_category', '=', 'position_trail')
        .execute();
      clock = Date.now();
      await dropPositionTrails(worker);
      const leftover = await dbWorker
        .selectFrom('cg.position')
        .select('id')
        .where('recorded_at', '<', new Date(Date.now() - 31 * 86_400_000))
        .execute();
      expect(leftover).toHaveLength(0);
      const logsAfter = await dbWorker
        .selectFrom('cg.deletion_log')
        .select(['deleted_count'])
        .where('tenant_id', '=', county)
        .where('data_category', '=', 'position_trail')
        .execute();
      expect(logsAfter.length).toBe(logsBefore.length + 1);
      expect(logsAfter.at(-1)!.deleted_count).toBeGreaterThanOrEqual(1);
      // Today's positions are untouched.
      const today = await dbWorker
        .selectFrom('cg.position')
        .select('id')
        .where('check_in_id', '=', checkIn.id)
        .execute();
      expect(today.length).toBeGreaterThanOrEqual(2);
    });
  },
);
