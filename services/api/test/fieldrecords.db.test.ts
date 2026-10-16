/**
 * Frontline role records from the field app (layer-4 task J), against the
 * database: FL:FR-01 search marks (once per phone id, the FEMA mark code,
 * USNG), FR-19 right of entry (a renter needs the landlord's consent; the
 * signer's name and signature are encrypted; reads are audited), FR-26 child
 * check-in (the pickup code is shown once and must match; a wrong code is
 * refused and audited), FR-14 / CON-16 shelter registration (wristband code
 * at the door, census from the open stays, check-out), FR-15 health notes
 * (health roles only, each read audited), FR-28 canvass ("no one home"
 * schedules a revisit), FR-21/22 stock (append-only by phone id), FR-24
 * interpreter requests, and the field commands that carry them (FLD-13).
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { roleTemplates, type AccountSubject } from '@cg/authz';
import { FieldCrypto, InMemoryKeyService, MemoryKeyStore } from '@cg/crypto';
import { createDb, type Database } from '@cg/db';
import type { Kysely } from 'kysely';
import { loadSeed } from '../../../tools/seed/src/load.ts';
import { buildApp, type App } from '../src/app.ts';
import { AuthError, type SubjectLoader } from '../src/auth/subject.ts';
import { routesWith } from '../src/routes/index.ts';

const appUrl = process.env['API_DB_TEST_APP_URL'];
const workerUrl = process.env['API_DB_TEST_WORKER_URL'];

type Json = Record<string, unknown>;

describe.skipIf(!appUrl || !workerUrl)('frontline role records (database-backed)', () => {
  let app: App;
  let dbApp: Kysely<Database>;
  let dbWorker: Kysely<Database>;
  let eventId: string;
  let siteId: string;
  let county: string;
  const subjects: Record<string, AccountSubject> = {};
  const accounts: Record<string, string> = {};
  const objects = new Map<string, Buffer>();
  const crypto = new FieldCrypto(new InMemoryKeyService(), new MemoryKeyStore());
  const s3 = {
    async send(cmd: { constructor: { name: string }; input: { Key: string; Body?: Buffer } }) {
      if (cmd.constructor.name === 'PutObjectCommand') {
        objects.set(cmd.input.Key, cmd.input.Body ?? Buffer.alloc(0));
        return {};
      }
      if (cmd.constructor.name === 'HeadObjectCommand') {
        const b = objects.get(cmd.input.Key);
        if (!b) throw new Error('NotFound');
        return { ContentLength: b.length };
      }
      throw new Error(`unexpected ${cmd.constructor.name}`);
    },
  };
  const call = async (who: string, method: 'GET' | 'POST', url: string, payload?: unknown) => {
    const res = await app.inject({
      method,
      url,
      headers: { authorization: `Bearer ${who}` },
      ...(payload !== undefined ? { payload: payload as Json } : {}),
    });
    return { status: res.statusCode, body: res.body, json: <T = Json>() => res.json() as T };
  };
  const create = async (who: string, kind: string, body: Json, expected = 201) => {
    const r = await call(who, 'POST', `/api/v1/field-records/${kind}`, body);
    expect(r.status, r.body).toBe(expected);
    return r.json();
  };

  beforeAll(async () => {
    dbApp = createDb(appUrl!, 3);
    dbWorker = createDb(workerUrl!, 2);
    const seeded = await loadSeed(dbWorker);
    county = seeded.tenants['county']!;
    const tenant = await dbWorker
      .selectFrom('cg.tenant')
      .select(['path', 'kind'])
      .where('id', '=', county)
      .executeTakeFirstOrThrow();
    eventId = (
      await dbWorker
        .selectFrom('cg.event')
        .select('id')
        .where('tenant_id', '=', county)
        .where('intake_slug', '=', 'westwind')
        .executeTakeFirstOrThrow()
    ).id;
    siteId = (
      await dbWorker
        .selectFrom('cg.site')
        .select('id')
        .where('tenant_id', '=', county)
        .where('confidential', '=', false)
        .orderBy('name')
        .executeTakeFirstOrThrow()
    ).id;
    for (const [who, template] of [
      ['sar', 'search_rescue'],
      ['crew', 'cleanup_crew_lead'],
      ['child', 'child_space_staff'],
      ['shelter', 'shelter_worker'],
      ['nurse', 'shelter_nurse'],
      ['canvass', 'canvasser'],
      ['stock', 'warehouse_staff'],
      ['interp', 'interpreter'],
      ['pets', 'animal_services'],
      ['pio', 'public_information_officer'],
      ['reception', 'volunteer_reception'],
      ['inspector', 'building_inspector'],
      ['roads', 'road_crew'],
      ['health', 'public_health_inspector'],
      ['host', 'facility_host'],
    ] as const) {
      const email = `${who}.fieldrecords@example.org`;
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
      accounts[who] = id;
      // A personnel record, as the field app needs for its outbox (FLD-13).
      const person = await dbWorker
        .selectFrom('cg.personnel')
        .select('id')
        .where('account_id', '=', id)
        .executeTakeFirst();
      if (!person)
        await dbWorker
          .insertInto('cg.personnel')
          .values({ tenant_id: county, name: `Exercise ${who}`, account_id: id, status: 'active' })
          .execute();
      const t = roleTemplates.find((r) => r.key === template);
      if (!t) throw new Error(`no template ${template}`);
      subjects[who] = {
        kind: 'account',
        accountId: id,
        tenantId: county,
        tenantPath: tenant.path,
        tenantKind: tenant.kind,
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
    }
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
      logLevel: process.env['TEST_LOG'] ?? 'silent',
      probes: [],
      db: dbApp,
      fieldCrypto: crypto,
      subjects: loader,
      routes: routesWith({
        fieldSync: {
          objects: {
            client: s3 as unknown as import('@aws-sdk/client-s3').S3Client,
            bucket: 'test',
            maxBytes: 1024 * 1024,
          },
        },
      }),
    });
  }, 120_000);

  afterAll(async () => {
    await app?.close();
    await dbApp?.destroy();
    await dbWorker?.destroy();
  });

  it('FL:FR-01, FLD-05, FLD-13: a search mark is recorded once with the FEMA mark code and a USNG; other roles cannot', async () => {
    const clientUuid = randomUUID();
    const body = {
      clientUuid,
      eventId,
      parcelId: `SYN-SAR-${clientUuid.slice(0, 6)}`,
      position: { lat: 38.79, lon: -90.87, accuracyM: 8 },
      occupantsFound: 2,
      occupantsRemoved: 1,
      victims: 0,
      hazards: ['gas'],
    };
    const first = await create('sar', 'search_mark', body);
    expect(first['markCode']).toMatch(/\[GAS\] \[0V 2L\/1R\]$/);
    expect(first['usng']).toMatch(/^15S /);
    // The resend answers with the same record.
    const again = await create('sar', 'search_mark', body, 200);
    expect(again['id']).toBe(first['id']);
    expect(
      (
        await call('pio', 'POST', '/api/v1/field-records/search_mark', {
          ...body,
          clientUuid: randomUUID(),
        })
      ).status,
    ).toBe(403);
    // Through the field outbox the result names the record kind (FLD-13, FLD-07 photo links).
    const cmdId = randomUUID();
    const cmd = await call('sar', 'POST', '/api/v1/field/commands', {
      commands: [
        { id: cmdId, kind: 'record.search_mark', body: { eventId, landmark: 'Red barn, Route 9' } },
      ],
    });
    expect(cmd.status, cmd.body).toBe(200);
    const result = cmd.json<{ results: { result: string; record: { type: string } | null }[] }>()
      .results[0]!;
    expect(result).toMatchObject({ result: 'applied', record: { type: 'search_mark' } });
  });

  it('FL:FR-19, SEC-10, SEC-18: a renter needs the landlord’s consent; the signer’s name and signature are encrypted and reads are audited', async () => {
    const base = {
      eventId,
      parcelId: 'SYN-ROE-1',
      signerRole: 'tenant',
      signerName: 'Exercise Resident Alpha',
      scope: 'Remove the fallen tree from the roof and tarp it.',
      signatureSvg: 'M10 10 L40 40 L80 12 L120 44',
    };
    const refused = await call('crew', 'POST', '/api/v1/field-records/right_of_entry', {
      ...base,
      clientUuid: randomUUID(),
    });
    expect(refused.status).toBe(400);
    expect(refused.body).toMatch(/landlord/);
    const signed = await create('crew', 'right_of_entry', {
      ...base,
      clientUuid: randomUUID(),
      landlordConsent: true,
    });
    expect(signed).toMatchObject({ signerName: 'Exercise Resident Alpha', signed: true });
    const row = await dbWorker
      .selectFrom('cg.right_of_entry')
      .select(['signer_name_enc', 'signature_key'])
      .where('id', '=', signed['id'] as string)
      .executeTakeFirstOrThrow();
    expect(row.signer_name_enc!.toString('utf8')).not.toContain('Alpha');
    const stored = objects.get(row.signature_key!);
    expect(stored).toBeDefined();
    expect(stored!.toString('utf8')).not.toContain('L40 40');
    const list = await call(
      'crew',
      'GET',
      `/api/v1/field-records/right_of_entry?eventId=${eventId}`,
    );
    expect(list.status).toBe(200);
    const reads = await dbWorker
      .selectFrom('cg.audit_event')
      .select('seq')
      .where('action', '=', 'right_of_entry.read')
      .where('actor_account_id', '=', accounts['crew']!)
      .execute();
    expect(reads.length).toBeGreaterThan(0);
    const release = await call(
      'crew',
      'POST',
      `/api/v1/field-records/right_of_entry/${signed['id'] as string}/release`,
      { signatureSvg: 'M5 5 L50 50 L90 10' },
    );
    expect(release.status, release.body).toBe(200);
    expect(release.json()['releaseSignedAt']).toBeTruthy();
  });

  it('FL:FR-26: the pickup code is shown once; a wrong code is refused and audited; the right one releases the child', async () => {
    const r = await create('child', 'child_check_in', {
      clientUuid: randomUUID(),
      siteId,
      childName: 'Exercise Child One',
      ageBand: '6-9',
      guardianName: 'Exercise Guardian One',
    });
    const code = r['pickupCode'] as string;
    expect(code).toMatch(/^[2-9A-HJ-NP-Z]{6}$/);
    const listed = await call(
      'child',
      'GET',
      `/api/v1/field-records/child_check_in?siteId=${siteId}&open=true`,
    );
    const mine = listed.json<Json[]>().find((x) => x['id'] === r['id'])!;
    expect(mine['childName']).toBe('Exercise Child One');
    expect(mine['pickupCode']).toBeUndefined();
    const wrong = await call(
      'child',
      'POST',
      `/api/v1/field-records/child_check_in/${r['id'] as string}/check-out`,
      {
        pickupCode: code === 'AAAAAA' ? 'BBBBBB' : 'AAAAAA',
        releasedTo: 'Someone else',
      },
    );
    expect(wrong.status).toBe(403);
    const refusedAudit = await dbWorker
      .selectFrom('cg.audit_event')
      .select('seq')
      .where('action', '=', 'child_check_in.pickup_refused')
      .where('target_id', '=', r['id'] as string)
      .execute();
    expect(refusedAudit.length).toBe(1);
    const still = await dbWorker
      .selectFrom('cg.child_check_in')
      .select('checked_out_at')
      .where('id', '=', r['id'] as string)
      .executeTakeFirstOrThrow();
    expect(still.checked_out_at).toBeNull();
    const ok = await call(
      'child',
      'POST',
      `/api/v1/field-records/child_check_in/${r['id'] as string}/check-out`,
      {
        pickupCode: code.toLowerCase().replace(/^(...)/, '$1-'),
        releasedTo: 'Exercise Guardian One',
      },
    );
    expect(ok.status, ok.body).toBe(200);
    expect(ok.json()['checkedOutTo']).toBe('Exercise Guardian One');
  });

  it('CON-16, FL:FR-14, FL:FR-15, ADM-05 G7: the shelter door finds a guest by wristband; census counts the open stays; health notes are for health roles only and every read is audited', async () => {
    const run = randomUUID().slice(0, 4).toUpperCase();
    const cot = (n: number) => `C${run}-${n}`;
    const stay = await create('shelter', 'shelter_stay', {
      clientUuid: randomUUID(),
      eventId,
      siteId,
      householdName: 'Exercise Household Beta',
      householdSize: 3,
      adults: 2,
      children: 1,
      cots: [cot(12), cot(13), cot(14)],
      accessNeeds: 'Uses a wheelchair; needs a ground-floor cot.',
      pets: 1,
    });
    const band = stay['wristbandCode'] as string;
    expect(band).toHaveLength(6);
    const found = await call('shelter', 'POST', '/api/v1/field-records/shelter_stay/lookup', {
      code: band,
    });
    expect(found.status).toBe(200);
    expect(found.json()['id']).toBe(stay['id']);
    const census = await call(
      'shelter',
      'GET',
      `/api/v1/field-records/shelter_stay/census?siteId=${siteId}`,
    );
    expect(census.json<{ cotsInUse: string[]; people: number }>().cotsInUse).toEqual(
      expect.arrayContaining([cot(12), cot(13), cot(14)]),
    );
    const enc = await dbWorker
      .selectFrom('cg.shelter_stay')
      .select('access_needs_enc')
      .where('id', '=', stay['id'] as string)
      .executeTakeFirstOrThrow();
    expect(enc.access_needs_enc!.toString('utf8')).not.toContain('wheelchair');
    // A health note is written and read by the nurse; the shelter worker may not read it.
    const hn = await create('nurse', 'health_note', {
      clientUuid: randomUUID(),
      siteId,
      shelterStayId: stay['id'],
      kind: 'medication_request',
      note: 'Needs a refill of an exercise medication by tonight.',
    });
    expect(hn['requestStatus']).toBe('open');
    expect(
      (await call('shelter', 'GET', `/api/v1/field-records/health_note?siteId=${siteId}`)).status,
    ).toBe(403);
    const notes = await call(
      'nurse',
      'GET',
      `/api/v1/field-records/health_note?shelterStayId=${stay['id'] as string}`,
    );
    expect(notes.json<Json[]>()[0]!['note']).toMatch(/refill/);
    const audited = await dbWorker
      .selectFrom('cg.audit_event')
      .select('seq')
      .where('action', '=', 'health_note.read')
      .where('actor_account_id', '=', accounts['nurse']!)
      .execute();
    expect(audited.length).toBeGreaterThan(0);
    const out = await call(
      'shelter',
      'POST',
      `/api/v1/field-records/shelter_stay/${stay['id'] as string}/check-out`,
      {
        reason: 'Went to stay with family',
      },
    );
    expect(out.status, out.body).toBe(200);
    const after = await call(
      'shelter',
      'GET',
      `/api/v1/field-records/shelter_stay/census?siteId=${siteId}`,
    );
    expect(after.json<{ cotsInUse: string[] }>().cotsInUse).not.toContain(cot(13));
  });

  it('FL:FR-28: "no one home" schedules a revisit reminder for the canvasser', async () => {
    const v = await create('canvass', 'canvass_visit', {
      clientUuid: randomUUID(),
      eventId,
      parcelId: 'SYN-CAN-1',
      outcome: 'no_one_home',
      doorHangerLeft: true,
    });
    expect(v['reminderId']).toBeTruthy();
    const reminder = await dbWorker
      .selectFrom('cg.reminder')
      .select(['kind', 'owner_account_id', 'subject_kind', 'due_at'])
      .where('id', '=', v['reminderId'] as string)
      .executeTakeFirstOrThrow();
    expect(reminder).toMatchObject({
      kind: 'revisit',
      owner_account_id: accounts['canvass'],
      subject_kind: 'canvass_visit',
    });
    expect(reminder.due_at.getTime()).toBeGreaterThan(Date.now());
    const spoke = await create('canvass', 'canvass_visit', {
      clientUuid: randomUUID(),
      eventId,
      parcelId: 'SYN-CAN-2',
      outcome: 'spoke_with_resident',
    });
    expect(spoke['reminderId']).toBeNull();
  });

  it('FL:FR-21, FR-22: stock moves once per phone id; a count sets the quantity; running low is said', async () => {
    const sku = `TARP-${randomUUID().slice(0, 6)}`;
    const move = (body: Json) =>
      call('stock', 'POST', '/api/v1/field-records/stock_movement', body);
    const received = await move({
      clientUuid: randomUUID(),
      item: { siteId, sku, name: 'Tarps 10x12', reorderAt: 5 },
      kind: 'received',
      quantity: 10,
    });
    expect(received.status, received.body).toBe(200);
    const itemId = received.json()['stockItemId'] as string;
    const issueId = randomUUID();
    const issued = await move({
      clientUuid: issueId,
      stockItemId: itemId,
      kind: 'issued',
      quantity: 6,
    });
    expect(issued.json()).toMatchObject({ quantity: 4, runningLow: true });
    // A resend of the same movement counts nothing again.
    const replay = await move({
      clientUuid: issueId,
      stockItemId: itemId,
      kind: 'issued',
      quantity: 6,
    });
    expect(replay.json()).toMatchObject({ quantity: 4 });
    const counted = await move({
      clientUuid: randomUUID(),
      stockItemId: itemId,
      kind: 'counted',
      quantity: 9,
    });
    expect(counted.json()).toMatchObject({ quantity: 9, runningLow: false });
    expect(
      (await move({ clientUuid: randomUUID(), stockItemId: itemId, kind: 'issued', quantity: -2 }))
        .status,
    ).toBe(400);
    expect(
      (await call('pio', 'GET', `/api/v1/field-records/stock_item?siteId=${siteId}`)).status,
    ).toBe(403);
  });

  it('FL:FR-24: an interpreter accepts and finishes a request; the order of steps is enforced', async () => {
    const req = await create('shelter', 'interpreter_request', {
      clientUuid: randomUUID(),
      eventId,
      language: 'Vietnamese',
      mode: 'phone',
      siteId,
    });
    expect(req).toMatchObject({ language: 'vietnamese', state: 'open' });
    const respond = (who: string, body: Json) =>
      call(
        who,
        'POST',
        `/api/v1/field-records/interpreter_request/${req['id'] as string}/respond`,
        body,
      );
    expect((await respond('interp', { state: 'done' })).status).toBe(409);
    expect((await respond('interp', { state: 'accepted' })).status).toBe(200);
    const done = await respond('interp', { state: 'done', minutes: 25 });
    expect(done.json()).toMatchObject({ state: 'done', minutes: 25 });
    // The shelter worker may request but not respond.
    expect((await respond('shelter', { state: 'in_progress' })).status).toBe(403);
  });

  it('FL:FR-08, FLD-07: a pet intake keeps only the owner’s code, and a field photo can document it', async () => {
    const pet = await create('pets', 'pet_intake', {
      clientUuid: randomUUID(),
      eventId,
      siteId,
      ownerReferenceCode: 'ww-4k7q',
      species: 'dog',
      description: 'Brown terrier mix, red collar',
    });
    expect(pet['ownerReferenceCode']).toBe('WW4K7Q');
    const ticket = await call('pets', 'POST', '/api/v1/field/photos', {
      clientUuid: randomUUID(),
      contentType: 'image/jpeg',
      bytes: 4,
      recordType: 'pet_intake',
      recordId: pet['id'],
    });
    expect(ticket.status, ticket.body).toBe(201);
  });

  it('FL:FR-20, PER-01, BDG-01: a walk-up volunteer is registered in one step, once; skills stay unverified; the badge code is shown once', async () => {
    const clientUuid = randomUUID();
    // A team of its own, so the seeded rosters other suites check stay as seeded.
    const team = await dbWorker
      .insertInto('cg.team')
      .values({
        tenant_id: county,
        event_id: eventId,
        key: `walkup-${clientUuid.slice(0, 8)}`,
        name: `Exercise walk-up team ${clientUuid.slice(0, 4)}`,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    const body = {
      clientUuid,
      eventId,
      person: { name: `Exercise Walk-up ${clientUuid.slice(0, 4)}`, phone: '3145550199' },
      skills: ['chainsaw'],
      waiverSigned: true,
      waiverVersion: 'exercise-2026-1',
      backgroundCheckStatus: 'pending',
      teamId: team.id,
      badge: { roleLabel: 'Volunteer' },
    };
    const r = await call('reception', 'POST', '/api/v1/volunteer-registrations', body);
    expect(r.status, r.body).toBe(201);
    const reg = r.json();
    expect(reg['badgeCode']).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    expect(reg['checkInId']).toBeTruthy();
    expect(reg).toMatchObject({
      backgroundCheckStatus: 'pending',
      waiverVersion: 'exercise-2026-1',
      assignedTeamId: team.id,
    });
    // The resend answers with the same registration and no second badge code.
    const again = await call('reception', 'POST', '/api/v1/volunteer-registrations', body);
    expect(again.status).toBe(200);
    expect(again.json()['id']).toBe(reg['id']);
    expect(again.json()['badgeCode']).toBeUndefined();
    const cred = await dbWorker
      .selectFrom('cg.credential')
      .select(['kind', 'status'])
      .where('personnel_id', '=', reg['personnelId'] as string)
      .execute();
    expect(cred).toEqual([{ kind: 'chainsaw', status: 'recorded' }]);
    const person = await dbWorker
      .selectFrom('cg.personnel')
      .select('contact_enc')
      .where('id', '=', reg['personnelId'] as string)
      .executeTakeFirstOrThrow();
    expect(person.contact_enc!.toString('utf8')).not.toContain('3145550199');
    // RULE-11: the background check is a status only.
    const cleared = await app.inject({
      method: 'PATCH',
      url: `/api/v1/volunteer-registrations/${reg['id'] as string}`,
      headers: { authorization: 'Bearer reception', 'if-match': String(reg['version']) },
      payload: { backgroundCheckStatus: 'cleared' },
    });
    expect(cleared.statusCode, cleared.body).toBe(200);
    expect(cleared.json()['backgroundCheckStatus']).toBe('cleared');
    expect(
      (await call('pio', 'GET', `/api/v1/volunteer-registrations?eventId=${eventId}`)).status,
    ).toBe(403);
  });

  it('FL:FR-04: a placard on a reported home tells the resident what it means, in their language, when they can be reached', async () => {
    const report = await dbWorker
      .selectFrom('cg.report')
      .select('id')
      .where('tenant_id', '=', county)
      .where('withdrawn_at', 'is', null)
      .orderBy('submitted_at', 'desc')
      .executeTakeFirstOrThrow();
    const r = await create('inspector', 'placard', {
      clientUuid: randomUUID(),
      eventId,
      parcelId: 'SYN-PLC-1',
      reportId: report.id,
      kind: 'unsafe',
    });
    expect(r['kind']).toBe('unsafe');
    // Queued when the resident opted in; otherwise the reason why not. Never refused for the role.
    expect(r['residentMessage']).toBeDefined();
    expect(r['residentMessage']).not.toBe('not_allowed');
  });

  it('FL:FR-05, FL:FR-06, FL:FR-09: a road is reported and cleared once; a debris load works out its cubic yards; an inspection keeps illness as a count; a walk-through is kept before and after; other roles cannot', async () => {
    const road = await create('roads', 'road_status', {
      clientUuid: randomUUID(),
      eventId,
      name: 'Exercise Old Mill Rd at the creek',
      status: 'impassable',
      reason: 'Exercise: tree across both lanes',
    });
    expect(road).toMatchObject({ status: 'impassable', name: 'Exercise Old Mill Rd at the creek' });
    const cleared = await call(
      'roads',
      'POST',
      `/api/v1/field-records/road_status/${road['id']}/clear`,
    );
    expect(cleared.status, cleared.body).toBe(200);
    expect(cleared.json()['status']).toBe('cleared');
    const again = await call(
      'roads',
      'POST',
      `/api/v1/field-records/road_status/${road['id']}/clear`,
    );
    expect(again.status).toBe(409);
    expect(
      (
        await call('pio', 'POST', '/api/v1/field-records/road_status', {
          clientUuid: randomUUID(),
          eventId,
          name: 'Exercise Pine St',
          status: 'closed',
        })
      ).status,
    ).toBe(403);

    // A 40 cubic-yard truck at 75% carries 30 cubic yards (FEMA PA load ticket).
    const load = await create('roads', 'debris_ticket', {
      clientUuid: randomUUID(),
      eventId,
      ticketNumber: `EX-${randomUUID().slice(0, 6)}`,
      debrisType: 'vegetative',
      truckId: 'EX-TRUCK-7',
      truckCapacityCy: 40,
      loadPercent: 75,
      disposalSite: 'Exercise burn site',
    });
    expect(load['cubicYards']).toBe(30);

    // Illness is a number, never a person (EQ-13).
    const inspection = await create('health', 'inspection', {
      clientUuid: randomUUID(),
      eventId,
      siteId,
      kind: 'shelter',
      checklist: { handwashing: 'yes', food_temps: 'no' },
      result: 'corrective',
      illnessCount: 3,
    });
    expect(inspection).toMatchObject({ result: 'corrective', illnessCount: 3 });
    const columns = await dbWorker
      .selectFrom('information_schema.columns' as never)
      .select('column_name' as never)
      .where('table_schema' as never, '=', 'cg' as never)
      .where('table_name' as never, '=', 'inspection' as never)
      .execute();
    expect(columns.map((c) => (c as { column_name: string }).column_name)).not.toContain(
      'person_id',
    );

    const before = await create('host', 'site_walkthrough', {
      clientUuid: randomUUID(),
      siteId,
      phase: 'before',
      keyHolders: 'Exercise: custodian and the principal',
      issues: 'Exercise: gym door sticks',
    });
    const after = await create('host', 'site_walkthrough', {
      clientUuid: randomUUID(),
      siteId,
      phase: 'after',
      issues: 'Exercise: scuffed floor in the gym',
    });
    expect([before['phase'], after['phase']]).toEqual(['before', 'after']);
    const walks = await call(
      'host',
      'GET',
      `/api/v1/field-records/site_walkthrough?siteId=${siteId}`,
    );
    expect(walks.status).toBe(200);
    expect(walks.json<{ id: string }[]>().map((w) => w.id)).toEqual(
      expect.arrayContaining([before['id'], after['id']]),
    );
    expect(
      (
        await call('pio', 'POST', '/api/v1/field-records/inspection', {
          clientUuid: randomUUID(),
          eventId,
          kind: 'shelter',
          result: 'pass',
        })
      ).status,
    ).toBe(403);
  });
});
