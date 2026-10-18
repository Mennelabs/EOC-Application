/**
 * Exercise data for the enclave (SCL-12, CLAUDE.md rule 1): two fictional
 * criminal-justice agencies serving the WESTWIND exercise county and their
 * enclave accounts, each with a role and screening dates chosen to exercise
 * the qualification rules (layer-5 plan §4): two officers are deliberately
 * not qualified (training lapsed; fingerprint check pending). Everything is
 * invented; emails use example.org subdomains (RFC 2606). Synthetic stacks
 * only: provisioning refuses this in production mode.
 *
 * Identities get the development password and a one-time-code credential so
 * the development test client can sign in (password + code); the browser
 * flow still asks for a passkey and registers one at first sign-in.
 */
import { sql, type Kysely } from 'kysely';
import {
  createCjisDb,
  type CjisDatabase,
  type EnclaveRole,
  type FingerprintStatus,
} from '@cg/cjis-db';
import type { FieldCrypto } from '@cg/crypto';
import { Sealer } from '../crypto.ts';
import type { EnclaveKeycloak } from '../idp/keycloak.ts';

export const EXERCISE_PASSWORD = 'Westwind-Exercise-2026!';
/**
 * The exercise mission the platform seed links to the enclave (tools/seed/src/load.ts
 * EXERCISE_CJI_REF, checked equal by a test). The two systems never talk; both sides
 * simply know this one fixed reference.
 */
export const EXERCISE_CJI_REF = 'WESTWIND-EXERCISE-CJIS-LINK-000000000000100';
/** Development only: the shared one-time-code secret of the exercise accounts. */
export const EXERCISE_OTP_SECRET = 'WESTWIND-EXERCISE-OTP-DEV-ONLY';

export interface ExerciseAgency {
  key: 'sheriff' | 'police';
  name: string;
  identifier: string;
  county: string;
}

export const EXERCISE_AGENCIES: readonly ExerciseAgency[] = [
  {
    key: 'sheriff',
    name: 'Westwind County Sheriff’s Office (exercise)',
    identifier: 'EXERCISE-WWCSO-01',
    county: 'county',
  },
  {
    key: 'police',
    name: 'Westwind City Police Department (exercise)',
    identifier: 'EXERCISE-WWCPD-02',
    county: 'city',
  },
];

export interface ExerciseAccount {
  email: string;
  name: string;
  agency: ExerciseAgency['key'];
  roles: EnclaveRole[];
  fingerprint: FingerprintStatus;
  /** Days since training was completed; training lasts 12 months (AT-2). */
  trainedDaysAgo: number | null;
}

export const EXERCISE_ACCOUNTS: readonly ExerciseAccount[] = [
  {
    email: 'deputy.reyes@sheriff.example.org',
    name: 'Dana Reyes',
    agency: 'sheriff',
    roles: ['officer'],
    fingerprint: 'cleared',
    trainedDaysAgo: 40,
  },
  {
    email: 'sgt.hollis@sheriff.example.org',
    name: 'Morgan Hollis',
    agency: 'sheriff',
    roles: ['supervisor'],
    fingerprint: 'cleared',
    trainedDaysAgo: 90,
  },
  {
    email: 'records.lane@sheriff.example.org',
    name: 'Avery Lane',
    agency: 'sheriff',
    roles: ['records_clerk'],
    fingerprint: 'cleared',
    trainedDaysAgo: 120,
  },
  {
    email: 'tac.admin@sheriff.example.org',
    name: 'Jordan Okafor',
    agency: 'sheriff',
    roles: ['agency_admin'],
    fingerprint: 'cleared',
    trainedDaysAgo: 60,
  },
  {
    email: 'laso@sheriff.example.org',
    name: 'Riley Brandt',
    agency: 'sheriff',
    roles: ['security_officer'],
    fingerprint: 'cleared',
    trainedDaysAgo: 30,
  },
  {
    email: 'auditor@sheriff.example.org',
    name: 'Casey Whitfield',
    agency: 'sheriff',
    roles: ['auditor'],
    fingerprint: 'cleared',
    trainedDaysAgo: 200,
  },
  {
    email: 'deputy.lapsed@sheriff.example.org',
    name: 'Sam Ferreira',
    agency: 'sheriff',
    roles: ['officer'],
    fingerprint: 'cleared',
    trainedDaysAgo: 400,
  },
  {
    email: 'deputy.pending@sheriff.example.org',
    name: 'Quinn Adler',
    agency: 'sheriff',
    roles: ['officer'],
    fingerprint: 'pending',
    trainedDaysAgo: 10,
  },
  {
    // Used only by the lockout drill (AC-7): five wrong passwords lock it for ten minutes.
    email: 'lockout.drill@sheriff.example.org',
    name: 'Drew Kincaid',
    agency: 'sheriff',
    roles: ['officer'],
    fingerprint: 'cleared',
    trainedDaysAgo: 15,
  },
  {
    email: 'officer.vance@police.example.org',
    name: 'Taylor Vance',
    agency: 'police',
    roles: ['officer'],
    fingerprint: 'cleared',
    trainedDaysAgo: 50,
  },
  {
    email: 'admin@police.example.org',
    name: 'Robin Castellano',
    agency: 'police',
    roles: ['agency_admin'],
    fingerprint: 'cleared',
    trainedDaysAgo: 70,
  },
  {
    email: 'laso@police.example.org',
    name: 'Emery Nakamura',
    agency: 'police',
    roles: ['security_officer'],
    fingerprint: 'cleared',
    trainedDaysAgo: 80,
  },
];

const day = 24 * 3600 * 1000;
const isoDate = (d: Date) => d.toISOString().slice(0, 10);

/** Default retention until the agency enters its state records schedule (plan §12.7). */
export const DEFAULT_RETENTION = [
  {
    category: 'records' as const,
    keep_days: 2557,
    basis: 'Default 7 years after closure until the agency enters its state records schedule',
  },
  {
    category: 'audit' as const,
    keep_days: 2557,
    basis: 'At least 7 years (platform floor; above the CJIS one-year minimum)',
  },
];

/**
 * The sheriff's office's record for the linked exercise mission: invented law-enforcement
 * details (SCL-12), encrypted under the agency key like any record. Loaded once.
 */
/**
 * Mutual aid (decision 2026-10-15): the sheriff's exercise record is shared with the city police
 * for the joint looting patrol, 30 days from provisioning, granted by the exercise sergeant. The
 * worker's `mutual-aid` job ends it when the time passes; a re-run after that grants it again, so
 * the exercise stays demonstrable.
 */
async function ensureExerciseShare(
  db: Kysely<CjisDatabase>,
  sheriffId: string,
  policeId: string,
): Promise<void> {
  const record = await db
    .selectFrom('cjis.record')
    .select('id')
    .where('agency_id', '=', sheriffId)
    .where('cji_ref', '=', EXERCISE_CJI_REF)
    .executeTakeFirst();
  if (!record) return;
  const standing = await db
    .selectFrom('cjis.record_share')
    .select('id')
    .where('record_id', '=', record.id)
    .where('to_agency_id', '=', policeId)
    .where('status', '=', 'active')
    .where('ends_at', '>', new Date())
    .executeTakeFirst();
  if (standing) return;
  const sergeant = await db
    .selectFrom('cjis.person')
    .select('id')
    .where(sql`lower(email)`, '=', 'sgt.hollis@sheriff.example.org')
    .executeTakeFirst();
  await db.transaction().execute(async (trx) => {
    const share = await trx
      .insertInto('cjis.record_share')
      .values({
        agency_id: sheriffId,
        record_id: record.id,
        to_agency_id: policeId,
        platform_mission_reference: 'M-00012',
        purpose: 'Joint looting patrol on Commercial Row (WESTWIND exercise)',
        ends_at: new Date(Date.now() + 30 * day),
        granted_by: sergeant?.id ?? null,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    await trx
      .insertInto('cjis.record_event')
      .values({
        agency_id: sheriffId,
        record_id: record.id,
        kind: 'shared',
        actor_person_id: sergeant?.id ?? null,
        detail: JSON.stringify({ shareId: share.id, toAgencyId: policeId, exercise: true }),
      })
      .execute();
  });
}

async function ensureExerciseRecord(
  db: Kysely<CjisDatabase>,
  crypto: FieldCrypto,
  agencyId: string,
  authorId: string,
): Promise<void> {
  const existing = await db
    .selectFrom('cjis.record')
    .select('id')
    .where('agency_id', '=', agencyId)
    .where('cji_ref', '=', EXERCISE_CJI_REF)
    .executeTakeFirst();
  if (existing) return;
  const sealer = new Sealer(crypto);
  const seal = async (v: string): Promise<Buffer> => (await sealer.seal(agencyId, v))!;
  await db.transaction().execute(async (trx) => {
    const rec = await trx
      .insertInto('cjis.record')
      .values({
        agency_id: agencyId,
        cji_ref: EXERCISE_CJI_REF,
        platform_county: 'county',
        origin: 'officer_initiated',
        classification: 'looting',
        offense_codes: ['EXERCISE-01'],
        case_number_enc: await seal('EXERCISE-WCSO-2026-0001'),
        summary_enc: await seal(
          'Exercise WESTWIND: report of people taking goods from a storm-damaged store on Commercial Row.',
        ),
        created_by: authorId,
        updated_by: authorId,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    await trx
      .insertInto('cjis.record_person')
      .values({
        agency_id: agencyId,
        record_id: rec.id,
        role: 'suspect',
        name_enc: await seal('Exercise Subject One'),
        notes_enc: await seal('Invented for the WESTWIND exercise; not a real person.'),
        created_by: authorId,
        updated_by: authorId,
      })
      .execute();
    await trx
      .insertInto('cjis.record_bodycam')
      .values({
        agency_id: agencyId,
        record_id: rec.id,
        camera_label: 'BWC-EXERCISE-1',
        officer_person_id: authorId,
        evidence_reference_enc: await seal('EXERCISE-EVIDENCE-0001'),
        created_by: authorId,
        updated_by: authorId,
      })
      .execute();
    for (const kind of ['created', 'person_added', 'bodycam_added'] as const)
      await trx
        .insertInto('cjis.record_event')
        .values({
          agency_id: agencyId,
          record_id: rec.id,
          kind,
          actor_person_id: authorId,
          detail: JSON.stringify({ exercise: true }),
        })
        .execute();
    await trx
      .insertInto('cjis.record_event')
      .values({
        agency_id: agencyId,
        record_id: rec.id,
        kind: 'narrative',
        narrative_role: 'officer',
        body_enc: await seal(
          'Exercise narrative: deputy arrived 10:05, two people left on foot, no injuries.',
        ),
        actor_person_id: authorId,
        detail: JSON.stringify({ exercise: true }),
      })
      .execute();
  });
}

export async function provisionExercise(
  databaseUrl: string,
  kc: EnclaveKeycloak,
  realm: string,
  crypto: FieldCrypto,
): Promise<{ agencies: number; accounts: number }> {
  const db = createCjisDb(databaseUrl, 2);
  try {
    const agencyIds = new Map<string, string>();
    for (const a of EXERCISE_AGENCIES) {
      const row = await db
        .insertInto('cjis.agency')
        .values({
          name: a.name,
          agency_identifier: a.identifier,
          platform_county: a.county,
          exercise: true,
        })
        .onConflict((oc) => oc.column('agency_identifier').doUpdateSet({ name: a.name }))
        .returning('id')
        .executeTakeFirstOrThrow();
      agencyIds.set(a.key, row.id);
      for (const r of DEFAULT_RETENTION) {
        await db
          .insertInto('cjis.retention_policy')
          .values({ agency_id: row.id, ...r })
          .onConflict((oc) => oc.columns(['agency_id', 'category']).doNothing())
          .execute();
      }
    }

    const now = Date.now();
    for (const acct of EXERCISE_ACCOUNTS) {
      const agencyId = agencyIds.get(acct.agency);
      if (!agencyId) throw new Error(`unknown exercise agency ${acct.agency}`);
      const trained =
        acct.trainedDaysAgo === null ? null : new Date(now - acct.trainedDaysAgo * day);
      const values = {
        agency_id: agencyId,
        email: acct.email,
        display_name: acct.name,
        status: 'active' as const,
        fingerprint_status: acct.fingerprint,
        fingerprint_adjudicated_on:
          acct.fingerprint === 'cleared' ? isoDate(new Date(now - 180 * day)) : null,
        training_completed_on: trained ? isoDate(trained) : null,
        training_expires_on: trained ? isoDate(new Date(trained.getTime() + 365 * day)) : null,
      };
      let person = await db
        .selectFrom('cjis.person')
        .select(['id', 'idp_subject'])
        .where(sql`lower(email)`, '=', acct.email.toLowerCase())
        .executeTakeFirst();
      if (!person) {
        person = await db
          .insertInto('cjis.person')
          .values(values)
          .returning(['id', 'idp_subject'])
          .executeTakeFirstOrThrow();
      } else {
        // Re-runs refresh the screening dates so the exercise stays qualified over time.
        await db.updateTable('cjis.person').set(values).where('id', '=', person.id).execute();
      }
      for (const role of acct.roles) {
        await db
          .insertInto('cjis.role_grant')
          .values({ agency_id: agencyId, person_id: person.id, role })
          .onConflict((oc) =>
            oc.columns(['person_id', 'role']).where('status', '=', 'active').doNothing(),
          )
          .execute();
      }
      const subject = await kc.ensureDevUser(realm, {
        email: acct.email,
        displayName: acct.name,
        password: EXERCISE_PASSWORD,
        otpSecret: EXERCISE_OTP_SECRET,
      });
      if (person.idp_subject !== subject) {
        await db
          .updateTable('cjis.person')
          .set({ idp_subject: subject, identity_state: 'created' })
          .where('id', '=', person.id)
          .execute();
      }
    }

    const sheriff = agencyIds.get('sheriff');
    const deputy = await db
      .selectFrom('cjis.person')
      .select('id')
      .where(sql`lower(email)`, '=', 'deputy.reyes@sheriff.example.org')
      .executeTakeFirst();
    if (sheriff && deputy) await ensureExerciseRecord(db, crypto, sheriff, deputy.id);
    const police = agencyIds.get('police');
    if (sheriff && police) await ensureExerciseShare(db, sheriff, police);

    for (const [, agencyId] of agencyIds) {
      await db
        .insertInto('cjis.audit_event')
        .values({
          agency_id: agencyId,
          actor_kind: 'system',
          action: 'exercise.provision',
          target_type: 'agency',
          target_id: agencyId,
          outcome: 'success',
          reason: 'Synthetic exercise agency and accounts (SCL-12)',
        })
        .execute();
    }
    return { agencies: agencyIds.size, accounts: EXERCISE_ACCOUNTS.length };
  } finally {
    await db.destroy();
  }
}
