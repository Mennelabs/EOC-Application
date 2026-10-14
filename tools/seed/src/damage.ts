/**
 * Synthetic damage reports, filed and reviewed (layer-6 task C; SCL-12):
 * resident reports on the seed's own parcels, already through review, so
 * the counting rule, the declaration view and the reports built on them
 * have numbers to show. Every review state, verification level and
 * exclusion the rule knows appears: approved and verified at the desk or in
 * the field, self-reported, awaiting review, inaccessible, witness and
 * helper reports, duplicates, withdrawn and rejected reports, pre-existing
 * damage, non-primary residences, apartments by unit and a building
 * reported by its manager. Deterministic for a given seed.
 *
 * Opt-in: the stack loads them only with SEED_DAMAGE_REPORTS set (existing
 * suites expect an empty review queue), and tests call it directly with
 * their own event. Written as the worker role; restricted answers are not
 * used, so nothing here needs field encryption. All values are invented.
 */
import { randomUUID } from 'node:crypto';
import { sql, type Kysely } from 'kysely';
import { withTenant, type Database } from '@cg/db';
import { westwindGraph } from '@cg/intake';
import { areas, parcels, zipCentroids, type Feature, type ParcelProps } from './county.ts';
import { Rng } from './random.ts';

export interface DamageSeed {
  tenantId: string;
  eventId: string;
  /** The account recorded as the reviewer of the decisions. */
  reviewerId: string;
  count: number;
  seed?: number;
  /** Makes reference codes unique per run (tests). */
  tag: string;
}

type Relationship = 'own_home' | 'helper' | 'witness' | 'organization';
type Review = 'submitted' | 'under_review' | 'approved' | 'rejected' | 'duplicate';
type Verification = 'self_reported' | 'desktop_verified' | 'field_verified' | 'cannot_verify';

export interface DamageSpec {
  parcelId: string;
  line1: string;
  unit: string | null;
  postal: string;
  position: [number, number];
  relationship: Relationship;
  review: Review;
  verification: Verification;
  degree: 'affected' | 'minor' | 'major' | 'destroyed' | 'no_damage' | null;
  homeType: 'house' | 'apartment_condo' | 'mobile_manufactured' | 'business';
  units: number | null;
  occupancy: 'rent' | 'own' | 'other' | null;
  insurance: string[] | null;
  access: string | null;
  primaryResidence: boolean | null;
  preExisting: boolean;
  withdrawn: boolean;
  /** Index of the earlier spec this one duplicates. */
  duplicateOf: number | null;
}

const HOME_TYPE: Record<ParcelProps['structure'], DamageSpec['homeType']> = {
  single_family: 'house',
  manufactured: 'mobile_manufactured',
  apartment_building: 'apartment_condo',
  commercial: 'business',
};

const centre = (f: Feature<ParcelProps>): [number, number] => {
  const ring = f.geometry.type === 'Polygon' ? f.geometry.coordinates[0]! : [];
  return [
    Math.round(((ring[0]![0] + ring[2]![0]) / 2) * 1e6) / 1e6,
    Math.round(((ring[0]![1] + ring[2]![1]) / 2) * 1e6) / 1e6,
  ];
};

/** The reports to file: deterministic for a seed. */
export function damageSpecs(count: number, seed = 6060): DamageSpec[] {
  const rng = new Rng(seed);
  const homes = parcels(new Rng(2026));
  const specs: DamageSpec[] = [];
  for (let i = 0; i < count; i++) {
    // Now and then a second report of a home already reported.
    if (i > 10 && rng.chance(0.05)) {
      const of = rng.int(0, specs.length - 1);
      const first = specs[of]!;
      specs.push({ ...first, review: 'duplicate', withdrawn: false, duplicateOf: of });
      continue;
    }
    const parcel = homes[(i * 7 + rng.int(0, 6)) % homes.length]!;
    const area = areas.find((a) => a.key === parcel.properties.area)!;
    const homeType = HOME_TYPE[parcel.properties.structure];
    const apartment = homeType === 'apartment_condo';
    const relationship = rng.weighted<Relationship>([
      ['own_home', 82],
      ['helper', 8],
      ['witness', 5],
      ['organization', apartment ? 5 : 0],
    ]);
    const outcome = rng.weighted<[Review, Verification]>([
      [['approved', 'desktop_verified'], 44],
      [['approved', 'field_verified'], 20],
      [['submitted', 'self_reported'], 14],
      [['under_review', 'desktop_verified'], 6],
      [['under_review', 'cannot_verify'], 6],
      [['rejected', 'self_reported'], 4],
      [['approved', 'self_reported'], 6],
    ]);
    const witness = relationship === 'witness';
    const position = centre(parcel);
    // The ZIP whose centre is nearest the home.
    const postal = [...zipCentroids].sort(
      (a, b) =>
        Math.hypot(a.location[0] - position[0], a.location[1] - position[1]) -
        Math.hypot(b.location[0] - position[0], b.location[1] - position[1]),
    )[0]!.postal;
    specs.push({
      parcelId: parcel.properties.parcelId,
      line1: parcel.properties.address.replace(/, Harmon City$/, ''),
      unit: apartment && relationship !== 'organization' ? `Apt ${rng.int(1, 24)}` : null,
      postal,
      position,
      relationship,
      review: outcome[0],
      verification: outcome[1],
      degree: rng.weighted<DamageSpec['degree']>([
        ['affected', 28],
        ['minor', 30],
        ['major', 24],
        ['destroyed', 12],
        ['no_damage', 3],
        [null, 3],
      ]),
      homeType,
      units: relationship === 'organization' ? parcel.properties.unitCount : null,
      occupancy: witness
        ? null
        : rng.chance(area.renterShare)
          ? 'rent'
          : rng.chance(0.95)
            ? 'own'
            : 'other',
      insurance: witness
        ? null
        : rng.weighted<string[] | null>([
            [['home_or_renters'], 40],
            [['flood'], 8],
            [['none'], 30],
            [['not_sure'], 14],
            [null, 8],
          ]),
      access:
        outcome[1] === 'cannot_verify' ? rng.pick(['road_closed', 'flooded', 'debris']) : null,
      primaryResidence: witness ? null : rng.chance(0.96),
      preExisting: rng.chance(0.03),
      withdrawn: rng.chance(0.02),
      duplicateOf: null,
    });
  }
  return specs;
}

const value = (v: unknown) => ({ kind: 'value', value: v });

/** Files and reviews the reports; returns their ids in spec order. */
export async function loadDamageReports(
  db: Kysely<Database>,
  o: DamageSeed,
): Promise<{ reportIds: string[]; specs: DamageSpec[] }> {
  const specs = damageSpecs(o.count, o.seed);
  const ids: string[] = [];
  await withTenant(db, { tenantId: o.tenantId }, async (trx) => {
    for (const [i, s] of specs.entries()) {
      const addressKey = [
        s.line1
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, ' ')
          .trim(),
        s.unit
          ?.toLowerCase()
          .replace(/[^a-z0-9]+/g, ' ')
          .trim(),
        s.postal,
      ]
        .filter(Boolean)
        .join('|');
      const location = await trx
        .insertInto('cg.location')
        .values({
          tenant_id: o.tenantId,
          line1: s.line1,
          unit: s.unit,
          city: 'Harmon City',
          state: 'MO',
          postal: s.postal,
          geom: sql`ST_SetSRID(ST_MakePoint(${s.position[0]}, ${s.position[1]}), 4326)`,
          precision: 'exact',
          source: 'resident',
          parcel_id: s.parcelId,
          address_key: addressKey,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      const answers: Record<string, unknown> = { home_type: value(s.homeType) };
      if (s.units !== null) answers['units'] = value(s.units);
      if (s.occupancy) answers['occupancy'] = value(s.occupancy);
      if (s.insurance) answers['insurance'] = value(s.insurance);
      if (s.access) answers['access'] = value(s.access);
      const counted = s.review === 'approved' && s.verification !== 'self_reported';
      const report = await trx
        .insertInto('cg.report')
        .values({
          tenant_id: o.tenantId,
          reference_code: `SYN-${o.tag}-${String(i + 1).padStart(4, '0')}`,
          execution_id: randomUUID(),
          event_id: o.eventId,
          graph_key: westwindGraph.key,
          graph_version: westwindGraph.version,
          channel_of_origin: 'web',
          channels_used: ['web'],
          relationship: s.relationship,
          location_id: location.id,
          answers: JSON.stringify(answers),
          review_state: s.review,
          verification_level: s.verification,
          fema_degree:
            s.verification === 'self_reported' && s.review !== 'approved' ? null : s.degree,
          fema_degree_set_by: counted ? o.reviewerId : null,
          fema_degree_set_at: counted ? new Date() : null,
          is_primary_residence: s.primaryResidence,
          pre_existing_damage: s.preExisting,
          duplicate_of: s.duplicateOf !== null ? ids[s.duplicateOf]! : null,
          withdrawn_at: s.withdrawn ? new Date() : null,
        })
        .returning(['id', 'version'])
        .executeTakeFirstOrThrow();
      ids.push(report.id);
      await trx
        .insertInto('cg.report_version')
        .values({
          tenant_id: o.tenantId,
          report_id: report.id,
          report_version: report.version,
          snapshot: JSON.stringify({ answers, review_state: s.review, synthetic: true }),
          changed_by_kind: 'system',
          changed_by: null,
          reason: 'synthetic exercise report (tools/seed)',
        })
        .execute();
      if (s.review === 'approved' || s.review === 'rejected' || s.review === 'duplicate')
        await trx
          .insertInto('cg.review_decision')
          .values({
            tenant_id: o.tenantId,
            report_id: report.id,
            report_version: report.version,
            reviewer_account_id: o.reviewerId,
            decision:
              s.review === 'approved'
                ? 'approve'
                : s.review === 'rejected'
                  ? 'reject'
                  : 'duplicate',
            reason: 'Synthetic exercise review (tools/seed)',
          })
          .execute();
    }
  });
  return { reportIds: ids, specs };
}
