/**
 * Shift hand-over against a real PostgreSQL (layer-7 task H; FL-12, AI-04,
 * AIG-01, AIG-05). A shelter worker checks out: the draft names what their
 * shift logged, the assignment still open on their team and the follow-ups in
 * their conversation notes (a count). With the AI feature on, the draft is
 * rewritten from the same facts with every street address removed before the
 * model and put back after; the worker confirms it and the record says they
 * kept it. A teammate on the next shift reads it; someone on another team
 * does not; nobody drafts another worker's hand-over; after check-out it is
 * too late. Runs only with API_DB_TEST_APP_URL and API_DB_TEST_WORKER_URL.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Kysely } from 'kysely';
import { fakeProvider, type AiProvider, type DraftRequest } from '@cg/ai';
import { roleTemplates, type AccountSubject } from '@cg/authz';
import { FieldCrypto, InMemoryKeyService, MemoryKeyStore } from '@cg/crypto';
import { createDb, withTenant, type Database } from '@cg/db';
import { loadSeed } from '../../../tools/seed/src/load.ts';
import { buildApp, type App } from '../src/app.ts';
import { AuthError, type SubjectLoader } from '../src/auth/subject.ts';
import { routesWith } from '../src/routes/index.ts';

const appUrl = process.env['API_DB_TEST_APP_URL'];
const workerUrl = process.env['API_DB_TEST_WORKER_URL'];
const HOUR = 3_600_000;

describe.skipIf(!appUrl || !workerUrl)('shift hand-over (database-backed)', () => {
  let app: App;
  let dbApp: Kysely<Database>;
  let dbWorker: Kysely<Database>;
  let county = '';
  let checkInId = '';
  const run = randomUUID().slice(0, 8);
  const subjects: Record<string, AccountSubject> = {};
  const crypto = new FieldCrypto(new InMemoryKeyService(), new MemoryKeyStore());
  /** What the model was given, to check nothing personal reached it. */
  const seen: DraftRequest[] = [];
  /** Set to make the model add a figure the shift's records do not hold (GATE-08). */
  let straying = false;
  const watching: AiProvider = {
    ...fakeProvider,
    llm: {
      extract: (r) => fakeProvider.llm!.extract(r),
      draft: async (r) => {
        seen.push(r);
        const real = await fakeProvider.llm!.draft!(r);
        if (!straying) return real;
        const first = real.output.sentences[0]!;
        return {
          ...real,
          output: {
            ...real.output,
            sentences: [
              ...real.output.sentences,
              { text: 'We checked 999 homes on Levee Road.', factIds: first.factIds },
            ],
          },
        };
      },
    },
  };

  const call = async (who: string, method: 'GET' | 'POST', url: string, payload?: unknown) => {
    const res = await app.inject({
      method,
      url: `/api/v1${url}`,
      headers: { authorization: `Bearer ${who}`, 'idempotency-key': randomUUID() },
      ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
    });
    return { status: res.statusCode, body: res.json() as Record<string, unknown> };
  };

  beforeAll(async () => {
    dbApp = createDb(appUrl!, 2);
    dbWorker = createDb(workerUrl!, 2);
    const seeded = await loadSeed(dbWorker);
    const c = await dbWorker
      .insertInto('cg.tenant')
      .values({
        kind: 'county',
        parent_id: seeded.tenants['region']!,
        slug: `exercise-handover-${run}`,
        name: `Exercise hand-over county ${run}`,
        status: 'provisioning',
      })
      .returning(['id', 'path', 'kind'])
      .executeTakeFirstOrThrow();
    county = c.id;
    const as = (template: string): AccountSubject => {
      const t = roleTemplates.find((x) => x.key === template)!;
      return {
        kind: 'account',
        accountId: randomUUID(),
        tenantId: county,
        tenantPath: c.path,
        tenantKind: c.kind,
        status: 'active',
        roles: [
          {
            roleId: randomUUID(),
            key: t.key,
            version: 1,
            templateKey: t.key,
            grants: t.grants,
            scope: {},
          },
        ],
        resolvedAt: new Date(),
      };
    };
    subjects['ana'] = as('shelter_worker');
    subjects['ben'] = as('shelter_worker');
    subjects['cy'] = as('shelter_worker');
    subjects['lead'] = as('team_lead');
    const now = Date.now();
    await withTenant(dbWorker, { tenantId: county }, async (trx) => {
      await trx
        .insertInto('cg.ai_use_register')
        .values({
          tenant_id: county,
          feature: 'field.handover',
          provider: 'fake',
          model: 'keyword-rules',
          model_version: null,
          data_sent: 'Shift records',
          decision_informed: 'A hand-over draft',
          human_checkpoint: 'The worker confirms it',
          owner: 'Field operations',
          evaluation: JSON.stringify({}),
          enabled: false,
        })
        .execute();
      const event = await trx
        .insertInto('cg.event')
        .values({
          tenant_id: county,
          name: `Exercise hand-over flood ${run}`,
          hazard_type: 'flood',
          status: 'active',
          opened_at: new Date(now - 48 * HOUR),
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      const person = async (who: string, name: string) => {
        await trx
          .insertInto('cg.account')
          .values({
            id: subjects[who]!.accountId,
            tenant_id: county,
            email: `${who}-${run}@example.org`,
            display_name: name,
          })
          .execute();
        return trx
          .insertInto('cg.personnel')
          .values({ tenant_id: county, account_id: subjects[who]!.accountId, name })
          .returning('id')
          .executeTakeFirstOrThrow();
      };
      const ana = await person('ana', 'Ana Exercise');
      const ben = await person('ben', 'Ben Exercise');
      const cy = await person('cy', 'Cy Exercise');
      const team = (key: string) =>
        trx
          .insertInto('cg.team')
          .values({ tenant_id: county, event_id: event.id, key, name: `Shelter ${key}` })
          .returning('id')
          .executeTakeFirstOrThrow();
      const north = await team(`north-${run}`);
      const south = await team(`south-${run}`);
      await trx
        .insertInto('cg.team_member')
        .values([
          { tenant_id: county, team_id: north.id, personnel_id: ana.id },
          { tenant_id: county, team_id: north.id, personnel_id: ben.id },
          { tenant_id: county, team_id: south.id, personnel_id: cy.id },
        ])
        .execute();
      const ci = await trx
        .insertInto('cg.check_in')
        .values({
          tenant_id: county,
          personnel_id: ana.id,
          event_id: event.id,
          team_id: north.id,
          method: 'event_code',
          started_at: new Date(now - 4 * HOUR),
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      checkInId = ci.id;
      const entry = (kind: 'assessment' | 'service' | 'check_in', summary: string, ago: number) =>
        trx
          .insertInto('cg.activity_entry')
          .values({
            tenant_id: county,
            event_id: event.id,
            personnel_id: ana.id,
            team_id: north.id,
            kind,
            summary,
            occurred_at: new Date(now - ago * HOUR),
          })
          .execute();
      await entry('check_in', 'Checked in by event code', 4);
      await entry('assessment', 'Assessment: minor damage at 12 Willow St', 3);
      await entry('assessment', 'Assessment: major damage at 48 Levee Rd', 2);
      await entry('service', 'Meals served: 40', 1);
      // Before the shift: not this shift's work.
      await entry('service', 'Meals served: 999', 30);
      const mission = (reference: string) =>
        trx
          .insertInto('cg.mission')
          .values({
            tenant_id: county,
            event_id: event.id,
            reference,
            kind: 'welfare_check',
            source: 'staff',
          })
          .returning('id')
          .executeTakeFirstOrThrow();
      const open = await mission(`M-${run}-1`);
      const done = await mission(`M-${run}-2`);
      await trx
        .insertInto('cg.assignment')
        .values([
          {
            tenant_id: county,
            mission_id: open.id,
            resource_kind: 'team',
            team_id: north.id,
            state: 'on_scene',
          },
          {
            tenant_id: county,
            mission_id: done.id,
            resource_kind: 'team',
            team_id: north.id,
            state: 'cleared',
          },
        ])
        .execute();
      await trx
        .insertInto('cg.scribe_session')
        .values({
          tenant_id: county,
          client_uuid: randomUUID(),
          account_id: subjects['ana']!.accountId,
          context: 'general',
          language: 'en',
          consent_method: 'tapped',
          consent_text: 'Exercise consent',
          consent_at: new Date(now - 2 * HOUR),
          state: 'confirmed',
          note_enc: await crypto.encrypt(
            county,
            JSON.stringify({
              needsHeard: ['Water'],
              helpGiven: [],
              followUps: ['Bring diapers tomorrow', 'Call back about the hotel'],
              referrals: [],
            }),
          ),
          confirmed_at: new Date(now - HOUR),
        })
        .execute();
    });
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
      // The deterministic fake stands in for OpenAI here (tests only, ADR-0043).
      routes: routesWith({ drafting: { ai: { providerFor: async () => watching } } }),
    });
  });

  afterAll(async () => {
    await app?.close();
    await dbWorker
      ?.updateTable('cg.tenant')
      .set({ status: 'closed' })
      .where('id', '=', county)
      .execute();
    await dbApp?.destroy();
    await dbWorker?.destroy();
  });

  it('FL-12: the rules draft what the shift logged, what is still open and the follow-ups, and nothing else', async () => {
    const res = await call('ana', 'GET', `/check-ins/${checkInId}/handover`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const rules = res.body['rules'] as string;
    expect(rules).toContain('Damage assessments recorded: 2');
    expect(rules).toContain('Service entries logged: 1');
    expect(rules).toContain(`Still open: M-${run}-1 (welfare check), on scene`);
    expect(rules).not.toContain(`M-${run}-2`);
    expect(rules).toContain('Follow-ups in the conversation notes saved this shift: 2');
    expect(rules).toContain('12 Willow St');
    expect(rules).not.toContain('999');
    expect(rules).not.toContain('diapers');
    const ids = (res.body['facts'] as { id: string }[]).map((f) => f.id);
    expect(ids).toEqual(
      expect.arrayContaining(['shift', 'count.assessment', 'count.service', 'open.1', 'followUps']),
    );
    const es = await call('ana', 'GET', `/check-ins/${checkInId}/handover?language=es`);
    expect(es.body['rules']).toContain('Evaluaciones de daños registradas: 2');
    // Another worker cannot see or draft it.
    expect((await call('ben', 'GET', `/check-ins/${checkInId}/handover`)).status).toBe(404);
  });

  let outputId = '';
  let text = '';
  it('AI-10, AIG-05: the AI draft is off until enabled; on, addresses never reach the model and come back after', async () => {
    const off = await call('ana', 'POST', `/check-ins/${checkInId}/handover/ai-draft`, {});
    expect(off.status).toBe(409);
    await withTenant(dbWorker, { tenantId: county }, (trx) =>
      trx
        .updateTable('cg.ai_use_register')
        .set({ enabled: true })
        .where('tenant_id', '=', county)
        .where('feature', '=', 'field.handover')
        .execute(),
    );
    const res = await call('ana', 'POST', `/check-ins/${checkInId}/handover/ai-draft`, {});
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    text = res.body['text'] as string;
    outputId = res.body['outputId'] as string;
    expect(text).toContain('12 Willow St');
    expect(text).toContain('48 Levee Rd');
    const sent = JSON.stringify(seen.at(-1));
    expect(sent).not.toContain('Willow');
    expect(sent).not.toContain('Levee');
    expect(sent).toContain('Damage assessments recorded');
  });

  it('AI-04, AI-09, GATE-08: a hand-over draft with a figure the shift never logged is refused, recorded and never shown', async () => {
    straying = true;
    try {
      const refused = await call('ana', 'POST', `/check-ins/${checkInId}/handover/ai-draft`, {});
      expect(refused.status).toBe(422);
      expect(refused.body['code']).toBe('ai_draft_refused');
      expect(JSON.stringify(refused.body)).not.toContain('We checked 999 homes');
    } finally {
      straying = false;
    }
    const recorded = await dbWorker
      .selectFrom('cg.ai_output')
      .select('outcome')
      .where('tenant_id', '=', county)
      .where('feature', '=', 'field.handover')
      .orderBy('created_at')
      .execute();
    expect(recorded.map((r) => r.outcome)).toEqual(['ok', 'invalid']);
  });

  it('FL-12, AIG-01: the worker confirms it; the record says it was kept; saving again updates it', async () => {
    const saved = await call('ana', 'POST', `/check-ins/${checkInId}/handover`, {
      text,
      ai: { outputId, changed: false },
    });
    expect(saved.status, JSON.stringify(saved.body)).toBe(201);
    expect(saved.body).toMatchObject({ aiDrafted: true, checkInId });
    const out = await dbWorker
      .selectFrom('cg.ai_output')
      .select(['human_action', 'acted_by', 'target_type'])
      .where('id', '=', outputId)
      .executeTakeFirstOrThrow();
    expect(out).toEqual({
      human_action: 'accepted',
      acted_by: subjects['ana']!.accountId,
      target_type: 'check_in',
    });
    const again = await call('ana', 'POST', `/check-ins/${checkInId}/handover`, {
      text: `${text} Exercise: the north door sticks.`,
    });
    expect(again.status).toBe(200);
    expect(again.body['version']).toBe(2);
    // Nobody leaves a hand-over for someone else's shift.
    expect(
      (await call('ben', 'POST', `/check-ins/${checkInId}/handover`, { text: 'x' })).status,
    ).toBe(404);
  });

  it('FL-12: the next shift on the team reads it; another team does not; a lead reads them all', async () => {
    const ben = await call('ben', 'GET', '/handovers?mine=true');
    expect(ben.status).toBe(200);
    const list = ben.body as unknown as { text: string; personnelName: string }[];
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ personnelName: 'Ana Exercise' });
    expect(list[0]!.text).toContain('north door sticks');
    const cy = await call('cy', 'GET', '/handovers');
    expect(cy.body).toEqual([]);
    const lead = await call('lead', 'GET', '/handovers');
    expect((lead.body as unknown as unknown[]).length).toBe(1);
  });

  it('FL-12: after check-out it is too late to leave one', async () => {
    await withTenant(dbWorker, { tenantId: county }, (trx) =>
      trx
        .updateTable('cg.check_in')
        .set({ ended_at: new Date(), end_reason: 'checked_out' })
        .where('id', '=', checkInId)
        .execute(),
    );
    const late = await call('ana', 'POST', `/check-ins/${checkInId}/handover`, { text: 'late' });
    expect(late.status).toBe(409);
  });
});
