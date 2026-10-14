/**
 * The counting rule over a real database (layer-6 task C; AC-14C, GATE-07,
 * DCL:DEC-03/04, SEC-05): synthetic reports filed and reviewed by the seed
 * tool, assigned to tracts, read back through row-level security as staff,
 * give exactly the totals an independent reading of the same reports gives;
 * every exclusion the rule knows occurs; another tenant sees nothing. Runs
 * only with API_DB_TEST_APP_URL and API_DB_TEST_WORKER_URL.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, withTenant, type Database } from '@cg/db';
import { cantReachReasonOf } from '@cg/field-core';
import { connectorFor, createRecordedHttp, recordingsDir, runPull } from '@cg/refdata';
import type { Kysely } from 'kysely';
import { loadDamageReports, type DamageSpec } from '../../../tools/seed/src/damage.ts';
import { loadSeed } from '../../../tools/seed/src/load.ts';
import { tractAt } from '../../../tools/seed/src/recordings.ts';
import { assignBatch } from '../../../services/worker/src/jobs/geography.ts';
import type { JobContext } from '../../../services/worker/src/jobs/types.ts';
import { countDamage, loadDamageRecords, type DamageRecord } from '../src/index.ts';

const appUrl = process.env['API_DB_TEST_APP_URL'];
const workerUrl = process.env['API_DB_TEST_WORKER_URL'];

const HOME: Record<DamageSpec['homeType'], DamageRecord['homeType']> = {
  house: 'single_family',
  apartment_condo: 'multi_family',
  mobile_manufactured: 'manufactured',
  business: 'non_residential',
};
const key = (s: string | null | undefined) =>
  (s ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

/** The same reports read straight from what was filed, without the database. */
function expected(specs: DamageSpec[], ids: string[]): DamageRecord[] {
  return specs.map((s, i) => {
    const building = s.relationship === 'organization' && s.homeType === 'apartment_condo';
    const ins = s.insurance ?? [];
    return {
      kind: 'report',
      id: ids[i]!,
      reviewState: s.review,
      verification: s.verification,
      degree: s.verification === 'self_reported' && s.review !== 'approved' ? null : s.degree,
      relationship: s.relationship,
      primaryResidence: s.primaryResidence,
      preExisting: s.preExisting,
      withdrawn: s.withdrawn,
      duplicateOf: s.duplicateOf !== null ? ids[s.duplicateOf]! : null,
      reportId: null,
      homeType: HOME[s.homeType],
      units: building ? s.units : 1,
      wholeBuilding: building,
      tenure:
        s.occupancy === 'own'
          ? 'owner'
          : s.occupancy === 'rent'
            ? 'renter'
            : s.occupancy === 'other'
              ? 'other'
              : 'unknown',
      insurance: ins.some((x) => x !== 'none' && x !== 'not_sure')
        ? 'insured'
        : ins.includes('none') && !ins.includes('not_sure')
          ? 'uninsured'
          : 'unknown',
      parcelId: s.parcelId,
      addressKey: [key(s.line1), key(s.unit), s.postal].filter(Boolean).join('|'),
      locationId: null,
      tractGeoid: `29999${tractAt(s.position[0]).tract}`,
      inaccessibleReason:
        s.verification === 'cannot_verify' ? (cantReachReasonOf(s.access) ?? 'not given') : null,
      at: 'same',
    };
  });
}

describe.skipIf(!appUrl || !workerUrl)('the counting rule over the database', () => {
  let worker: Kysely<Database>;
  let app: Kysely<Database>;
  let county = '';
  let seededCounty = '';
  let eventId = '';
  const run = randomUUID().slice(0, 8);
  let filed: { reportIds: string[]; specs: DamageSpec[] };

  beforeAll(async () => {
    worker = createDb(workerUrl!, 3);
    app = createDb(appUrl!, 3);
    const seeded = await loadSeed(worker);
    seededCounty = seeded.tenants['county']!;
    county = (
      await worker
        .insertInto('cg.tenant')
        .values({
          kind: 'county',
          parent_id: seeded.tenants['region']!,
          slug: `exercise-count-${run}`,
          name: `Exercise counting ${run}`,
          status: 'provisioning',
        })
        .returning('id')
        .executeTakeFirstOrThrow()
    ).id;
    eventId = await withTenant(worker, { tenantId: county }, async (trx) => {
      await trx
        .insertInto('cg.tenant_config')
        .values({ tenant_id: county, key: 'refdata.enabled', value: JSON.stringify(false) })
        .execute();
      return (
        await trx
          .insertInto('cg.event')
          .values({
            tenant_id: county,
            name: `Exercise counting event ${run}`,
            hazard_type: 'tornado',
            status: 'active',
            opened_at: new Date(),
          })
          .returning('id')
          .executeTakeFirstOrThrow()
      ).id;
    });
    const tracts = connectorFor('tract');
    if (!tracts || tracts === 'import') throw new Error('no tract connector');
    await runPull(worker, tracts, {
      tenantId: county,
      mode: 'recorded',
      http: createRecordedHttp(recordingsDir),
      scope: { stateFips: '29', countyFips: ['29999'] },
      secrets: {},
      now: () => new Date(),
    });
    filed = await loadDamageReports(worker, {
      tenantId: county,
      eventId,
      reviewerId: randomUUID(),
      count: 160,
      tag: run,
    });
    while ((await assignBatch({ db: worker } as JobContext, county)) > 0);
  });

  afterAll(async () => {
    await worker
      ?.updateTable('cg.tenant')
      .set({ status: 'closed' })
      .where('slug', '=', `exercise-count-${run}`)
      .execute();
    await worker?.destroy();
    await app?.destroy();
  });

  it('gives exactly the totals an independent reading of the filed reports gives (AC-14C)', async () => {
    const records = await withTenant(app, { tenantId: county }, (trx) =>
      loadDamageRecords(trx, eventId),
    );
    expect(records).toHaveLength(160);
    const actual = countDamage(records.map((r) => ({ ...r, at: 'same' })));
    const want = countDamage(expected(filed.specs, filed.reportIds));
    expect(actual).toEqual(want);
    expect(actual.counted.cells.reduce((n, c) => n + c.units, 0)).toBe(actual.counted.units);
    expect(actual.counted.byTract.reduce((n, t) => n + t.units, 0)).toBe(actual.counted.units);
    expect(actual.counted.byTract.every((t) => t.tractGeoid !== null)).toBe(true);
  });

  it('exercises every way a record leaves the totals', async () => {
    const t = countDamage(
      await withTenant(app, { tenantId: county }, (trx) => loadDamageRecords(trx, eventId)),
    );
    expect(t.counted.units).toBeGreaterThan(0);
    for (const n of [
      t.shownSeparately.selfReported,
      t.shownSeparately.awaitingReview,
      t.shownSeparately.inaccessible.total,
      t.shownSeparately.witness,
      t.shownSeparately.nonResidential,
      t.merged,
      t.excluded.rejected,
    ])
      expect(n).toBeGreaterThan(0);
    // DCL:DEC-17: inaccessible homes carry FEMA's reason, private or public road or bridge.
    expect(Object.keys(t.shownSeparately.inaccessible.byReason).sort()).toEqual([
      'private_road_or_bridge',
      'public_road_or_bridge',
    ]);
  });

  it('another tenant reads none of these records (SEC-05)', async () => {
    const records = await withTenant(app, { tenantId: seededCounty }, (trx) =>
      loadDamageRecords(trx, eventId),
    );
    expect(records).toEqual([]);
  });
});
