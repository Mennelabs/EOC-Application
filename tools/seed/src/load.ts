/**
 * Loads the synthetic WESTWIND county into a running stack (SCL-12, docs/02):
 * tenant hierarchy, template roles, the console cast as staff accounts with
 * role assignments, and provisioning messages for the worker (identity
 * realms, invitations). Runs as the cg_worker role; idempotent by slug/email.
 *
 *   DATABASE_URL=postgres://cg_worker:...@localhost:5432/cg node tools/seed/src/load.ts
 *
 * Staff accounts get the synthetic password below in development so the
 * exercise can be driven without email round-trips; the passkey is still
 * required on first browser login (SEC-07).
 */
import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { createDb, withTenant, type Database, type MissionTable } from '@cg/db';

type MissionKind = MissionTable['kind'];
import { openAIDescriptor } from '@cg/ai';
import { EVENT_TEMPLATE_DEFAULTS, westwindGraph } from '@cg/intake';
import {
  ensureAiRegister,
  ensureIntakeGraph,
  ensureRetentionDefaults,
  ensureTemplateRoles,
} from '@cg/provisioning';
import type { Kysely, Transaction } from 'kysely';
import { loadDamageReports } from './damage.ts';
import {
  tenants as tenantSpecs,
  agreements as agreementSpecs,
  resources as resourceSpecs,
  sites as siteSpecs,
  facilities as facilitySpecs,
  teams as teamSpecs,
  zipCentroids,
  buildCounty,
  EXERCISE_CHECK_IN_CODE,
  FIELD_ACCOUNTS,
  type TeamSpec,
} from './county.ts';

export const DEV_PASSWORD = 'Westwind-Exercise-2026!';
/** Fixed ids so re-runs and tests can refer to the seed actors. */
export const SEED_ACTOR_A = '01900000-5eed-4000-8000-00000000000a';
export const SEED_ACTOR_B = '01900000-5eed-4000-8000-00000000000b';

/** The WESTWIND cast (docs/02) and which template each holds. */
export const cast = [
  {
    email: 'dana.director@example.org',
    name: 'Dana Rivera',
    role: 'county_em_director',
    tenant: 'county',
  },
  {
    email: 'security.admin@example.org',
    name: 'Sam Okafor',
    role: 'security_admin',
    tenant: 'county',
  },
  { email: 'admin@example.org', name: 'Jordan Lindqvist', role: 'tenant_admin', tenant: 'county' },
  {
    email: 'marcus.gis@example.org',
    name: 'Marcus Haddad',
    role: 'planning_gis_lead',
    tenant: 'county',
  },
  {
    email: 'priya.assessment@example.org',
    name: 'Priya Nguyen',
    role: 'damage_assessment_coordinator',
    tenant: 'county',
  },
  {
    email: 'luis.masscare@example.org',
    name: 'Luis Castillo',
    role: 'mass_care_coordinator',
    tenant: 'county',
  },
  {
    email: 'keisha.afn@example.org',
    name: 'Keisha Brennan',
    role: 'afn_coordinator',
    tenant: 'county',
  },
  {
    email: 'tomas.pio@example.org',
    name: 'Tomás Moreau',
    role: 'public_information_officer',
    tenant: 'county',
  },
  { email: 'jen.coad@example.org', name: 'Jen Kowalski', role: 'coad_chair', tenant: 'coad' },
  {
    email: 'ruth.canteen@example.org',
    name: 'Ruth Adeyemi',
    role: 'ngo_incident_commander',
    tenant: 'canteen',
  },
  {
    email: 'state.liaison@example.org',
    name: 'Alex Fairbank',
    role: 'state_liaison',
    tenant: 'state',
  },
  { email: 'nurse@example.org', name: 'Mei Delgado', role: 'shelter_nurse', tenant: 'shelter-ngo' },
  // Layer 4: the field side of the exercise (DSP-09, DSP-10, FLD-03).
  { email: 'rowan.field@example.org', name: 'Rowan Achebe', role: 'team_lead', tenant: 'county' },
  {
    email: 'casey.dispatch@example.org',
    name: 'Casey Whitfield',
    role: 'field_coordinator',
    tenant: 'county',
  },
  {
    email: 'pat.netcontrol@example.org',
    name: 'Pat Iverson',
    role: 'net_control',
    tenant: 'county',
  },
  // Layer 5 (SEC-12): links missions to the CJIS enclave; holds no CJI on the platform.
  {
    email: 'liaison@example.org',
    name: 'Kendall Brooks',
    role: 'law_enforcement_liaison',
    tenant: 'county',
  },
  {
    email: 'dispatch.cleanup@example.org',
    name: 'Cleanup dispatcher',
    role: 'agency_dispatcher',
    tenant: 'cleanup',
  },
  // Partner organizations run their own accounts (ADM-02, decision 2026-10-13). Each gets
  // a tenant administrator and a security administrator, because granting a role needs a
  // second administrator inside the same organization (ADM-05 G6). The state's pair onboards
  // its own liaisons (layer 6).
  ...(['coad', 'canteen', 'shelter-ngo', 'cleanup', 'legal', 'state'] as const).flatMap(
    (tenant) => [
      {
        email: `admin.${tenant}@example.org`,
        name: `${tenant} administrator`,
        role: 'tenant_admin',
        tenant,
      },
      {
        email: `security.${tenant}@example.org`,
        name: `${tenant} security administrator`,
        role: 'security_admin',
        tenant,
      },
    ],
  ),
] as const;

interface Loaded {
  tenants: Record<string, string>;
  accounts: Record<string, string>;
}

async function ensureTenant(
  db: Kysely<Database>,
  spec: (typeof tenantSpecs)[number],
  parentId: string | null,
): Promise<{ id: string; created: boolean }> {
  const existing = await db
    .selectFrom('cg.tenant')
    .select('id')
    .where('slug', '=', spec.key)
    .executeTakeFirst();
  if (existing) return { id: existing.id, created: false };
  const row = await db
    .insertInto('cg.tenant')
    .values({
      kind: spec.kind,
      parent_id: parentId,
      slug: spec.key,
      name: spec.name,
      timezone: spec.timezone,
      locales: spec.locales,
      status: 'provisioning',
      security_contact_email: `security+${spec.key}@example.org`,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  return { id: row.id, created: true };
}

async function ensureAccount(
  trx: Transaction<Database>,
  tenantId: string,
  member: (typeof cast)[number],
  roleId: string,
): Promise<{ id: string; created: boolean }> {
  const existing = await trx
    .selectFrom('cg.account')
    .select('id')
    .where('tenant_id', '=', tenantId)
    .where('email', '=', member.email)
    .executeTakeFirst();
  if (existing) return { id: existing.id, created: false };
  const account = await trx
    .insertInto('cg.account')
    .values({
      tenant_id: tenantId,
      email: member.email,
      display_name: member.name,
      status: 'active',
      activated_at: new Date(),
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  await trx
    .insertInto('cg.account_lifecycle')
    .values({
      tenant_id: tenantId,
      account_id: account.id,
      from_status: null,
      to_status: 'active',
      reason: 'seed',
      actor_account_id: null,
    })
    .execute();
  await trx
    .insertInto('cg.role_assignment')
    .values({
      tenant_id: tenantId,
      account_id: account.id,
      role_id: roleId,
      scope: '{}',
      granted_by: SEED_ACTOR_A,
      approved_by: SEED_ACTOR_B,
      created_by: SEED_ACTOR_A,
      updated_by: SEED_ACTOR_B,
    })
    .execute();
  await trx
    .insertInto('cg.outbox')
    .values({
      tenant_id: tenantId,
      topic: 'account.invited',
      payload: JSON.stringify({ accountId: account.id, devPassword: DEV_PASSWORD }),
      execution_id: randomUUID(),
    })
    .execute();
  return { id: account.id, created: true };
}

/** CON-02: the shipped event templates by hazard, for each hazard the county has none for yet. */
async function ensureEventTemplates(trx: Transaction<Database>, tenantId: string): Promise<void> {
  const have = new Set(
    (
      await trx
        .selectFrom('cg.event_template')
        .select('hazard_type')
        .where('tenant_id', '=', tenantId)
        .execute()
    ).map((r) => r.hazard_type),
  );
  for (const d of EVENT_TEMPLATE_DEFAULTS)
    if (!have.has(d.hazardType))
      await trx
        .insertInto('cg.event_template')
        .values({
          tenant_id: tenantId,
          hazard_type: d.hazardType,
          name: d.name,
          config: JSON.stringify(d.config),
          created_by: SEED_ACTOR_A,
          updated_by: SEED_ACTOR_A,
        })
        .execute();
}

/** The WESTWIND tornado exercise event with its public intake link and keywords (docs/02, CHN-08). */
async function ensureExerciseEvent(trx: Transaction<Database>, tenantId: string): Promise<void> {
  const existing = await trx
    .selectFrom('cg.event')
    .select('id')
    .where('tenant_id', '=', tenantId)
    .where('intake_slug', '=', 'westwind')
    .executeTakeFirst();
  if (existing) {
    // Databases seeded before layer 4 get the check-in code (FLD-03).
    await trx
      .updateTable('cg.event')
      .set({ check_in_code: EXERCISE_CHECK_IN_CODE })
      .where('id', '=', existing.id)
      .where('check_in_code', 'is', null)
      .execute();
    return;
  }
  await trx
    .insertInto('cg.event')
    .values({
      tenant_id: tenantId,
      name: 'Exercise WESTWIND tornado',
      hazard_type: 'tornado',
      status: 'active',
      intake_slug: 'westwind',
      intake_keywords: ['DAMAGE', 'DANOS', 'DAÑOS'],
      check_in_code: EXERCISE_CHECK_IN_CODE,
      opened_at: new Date(),
      created_by: SEED_ACTOR_A,
      updated_by: SEED_ACTOR_A,
    })
    .execute();
}

/** The county's text and voice number: a fictional 555 number on the simulator (docs/06, CHN-03). */
export const SEED_COUNTY_NUMBER = '+13145550100';

async function ensureChannelNumber(trx: Transaction<Database>, tenantId: string): Promise<void> {
  await trx
    .insertInto('cg.channel_number')
    .values({
      tenant_id: tenantId,
      number: SEED_COUNTY_NUMBER,
      provider: 'simulator',
      label: 'Exercise toll-free number (simulator)',
      verified_at: new Date(),
      created_by: SEED_ACTOR_A,
      updated_by: SEED_ACTOR_A,
    })
    .onConflict((oc) => oc.doNothing())
    .execute();
  await trx
    .insertInto('cg.tenant_config')
    .values({
      tenant_id: tenantId,
      key: 'intake.help_phone',
      value: JSON.stringify('(314) 555-0142'),
      created_by: SEED_ACTOR_A,
      updated_by: SEED_ACTOR_A,
    })
    .onConflict((oc) => oc.doNothing())
    .execute();
}

/** The WESTWIND facility registry, approved by the exercise EM director (REC-01). */
async function ensureFacilities(trx: Transaction<Database>, tenantId: string): Promise<void> {
  for (const spec of facilitySpecs) {
    const existing = await trx
      .selectFrom('cg.facility')
      .select('id')
      .where('tenant_id', '=', tenantId)
      .where('name', '=', spec.name)
      .executeTakeFirst();
    if (existing) continue;
    const location = await trx
      .insertInto('cg.location')
      .values({
        tenant_id: tenantId,
        line1: spec.address.line1,
        city: spec.address.city,
        state: 'MO',
        postal: spec.address.postal,
        geom: sql`ST_SetSRID(ST_MakePoint(${spec.location[0]}, ${spec.location[1]}), 4326)`,
        precision: 'exact',
        source: 'reviewer',
        created_by: SEED_ACTOR_A,
        updated_by: SEED_ACTOR_A,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    await trx
      .insertInto('cg.facility')
      .values({
        tenant_id: tenantId,
        name: spec.name,
        kind: spec.kind as 'school',
        location_id: location.id,
        sqft: spec.sqft,
        ada: spec.ada,
        power_backup: spec.powerBackup as 'none',
        kitchen: spec.kitchen,
        showers: spec.showers,
        pet_policy: spec.petPolicy as 'none',
        parking_spaces: spec.parkingSpaces,
        truck_access: spec.truckAccess,
        floodplain: spec.floodplain as 'out' | null,
        mou_status: spec.mouStatus as 'none',
        communities: spec.communities,
        notes: null,
        contacts_enc: null,
        owner_tenant_id: null,
        mou_expires_on: null,
        source: 'import',
        approved_by: SEED_ACTOR_A,
        approved_at: new Date(),
        created_by: SEED_ACTOR_A,
        updated_by: SEED_ACTOR_A,
      })
      .execute();
  }
}

/** Sites with their locations, published ones with a publication row (CON-09, PUB-06). */
async function ensureSites(trx: Transaction<Database>, tenantId: string): Promise<void> {
  for (const spec of siteSpecs) {
    const existing = await trx
      .selectFrom('cg.site')
      .select('id')
      .where('tenant_id', '=', tenantId)
      .where('slug', '=', spec.slug)
      .executeTakeFirst();
    if (existing) continue;
    const location = await trx
      .insertInto('cg.location')
      .values({
        tenant_id: tenantId,
        line1: spec.address.line1,
        city: spec.address.city,
        state: 'MO',
        postal: spec.address.postal,
        geom: sql`ST_SetSRID(ST_MakePoint(${spec.location[0]}, ${spec.location[1]}), 4326)`,
        precision: 'exact',
        source: 'reviewer',
        created_by: SEED_ACTOR_A,
        updated_by: SEED_ACTOR_A,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    const now = new Date();
    const site = await trx
      .insertInto('cg.site')
      .values({
        tenant_id: tenantId,
        kind: spec.kind,
        name: spec.name,
        slug: spec.slug,
        location_id: location.id,
        status: spec.status,
        capacity: spec.capacity ?? null,
        occupancy: spec.occupancy ?? null,
        hours: JSON.stringify(spec.hours),
        services: spec.services,
        pets: spec.pets,
        accessibility: JSON.stringify(spec.accessibility),
        medical_power: spec.medicalPower,
        languages: spec.languages,
        transit: spec.transit ?? null,
        directions: spec.directions ?? null,
        confidential: spec.confidential ?? false,
        confirm_every_hours: 12,
        last_confirmed_at: now,
        last_confirmed_by: SEED_ACTOR_A,
        published_version: spec.publish ? 1 : null,
        published_at: spec.publish ? now : null,
        created_by: SEED_ACTOR_A,
        updated_by: SEED_ACTOR_A,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    if (spec.publish) {
      await trx
        .insertInto('cg.publication')
        .values({
          tenant_id: tenantId,
          subject_kind: 'site',
          subject_id: site.id,
          subject_version: 1,
          snapshot: JSON.stringify({ ...spec, address: spec.address }),
          approved_by: SEED_ACTOR_A,
          reason: 'synthetic WESTWIND seed',
        })
        .execute();
    }
  }
}

async function ensureZipCentroids(trx: Transaction<Database>, tenantId: string): Promise<void> {
  for (const z of zipCentroids) {
    await trx
      .insertInto('cg.zip_centroid')
      .values({
        tenant_id: tenantId,
        postal: z.postal,
        name: z.name,
        geom: sql`ST_SetSRID(ST_MakePoint(${z.location[0]}, ${z.location[1]}), 4326)`,
      })
      .onConflict((oc) => oc.doNothing())
      .execute();
  }
}

/** Resources with English and Spanish text; published ones get a publication row (F16, PUB-18). */
async function ensureResources(trx: Transaction<Database>, tenantId: string): Promise<void> {
  for (const spec of resourceSpecs) {
    const existing = await trx
      .selectFrom('cg.resource')
      .select('id')
      .where('tenant_id', '=', tenantId)
      .where('slug', '=', spec.slug)
      .executeTakeFirst();
    if (existing) continue;
    const now = new Date();
    const expires =
      spec.expiresInDays === undefined
        ? null
        : new Date(now.getTime() + spec.expiresInDays * 86_400_000);
    const published = spec.status !== 'draft';
    const resource = await trx
      .insertInto('cg.resource')
      .values({
        tenant_id: tenantId,
        slug: spec.slug,
        type: spec.type,
        category: spec.category,
        ordering: spec.ordering,
        owner_account_id: SEED_ACTOR_A,
        status: spec.status,
        expires_at: expires,
        reference_url: spec.referenceUrl ?? null,
        link_status: spec.referenceUrl ? 'unchecked' : 'ok',
        published_version: published ? 1 : null,
        published_at: published ? now : null,
        created_by: SEED_ACTOR_A,
        updated_by: SEED_ACTOR_A,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    for (const [locale, text] of Object.entries(spec.text)) {
      await trx
        .insertInto('cg.resource_text')
        .values({
          tenant_id: tenantId,
          resource_id: resource.id,
          locale,
          title: text.title,
          summary: text.summary,
          body_html: text.bodyHtml,
          human_reviewed_by: SEED_ACTOR_A,
          reviewed_at: now,
          created_by: SEED_ACTOR_A,
          updated_by: SEED_ACTOR_A,
        })
        .execute();
    }
    if (published) {
      await trx
        .insertInto('cg.publication')
        .values({
          tenant_id: tenantId,
          subject_kind: 'resource',
          subject_id: resource.id,
          subject_version: 1,
          snapshot: JSON.stringify(spec),
          approved_by: SEED_ACTOR_A,
          reason: 'synthetic WESTWIND seed',
        })
        .execute();
    }
  }
}

/** Signed agreements county → partner organizations (SCL-01, NED-03/04). */
async function ensureAgreements(
  trx: Transaction<Database>,
  countyId: string,
  tenantIds: Record<string, string>,
): Promise<void> {
  for (const spec of agreementSpecs) {
    const partnerId = tenantIds[spec.partner];
    if (!partnerId) continue;
    const existing = await trx
      .selectFrom('cg.data_sharing_agreement')
      .select('id')
      .where('from_tenant_id', '=', countyId)
      .where('to_tenant_id', '=', partnerId)
      .executeTakeFirst();
    if (existing) continue;
    await trx
      .insertInto('cg.data_sharing_agreement')
      .values({
        from_tenant_id: countyId,
        to_tenant_id: partnerId,
        scope: 'consented_records',
        data_categories: spec.categories,
        status: 'signed',
        terms: JSON.stringify({
          orgType: spec.orgType,
          service: spec.service,
          recallOnWithdrawal: true,
          deleteOnRecall: true,
        }),
        signed_at: new Date(),
        signed_by: SEED_ACTOR_A,
        created_by: SEED_ACTOR_A,
        updated_by: SEED_ACTOR_A,
      })
      .execute();
  }
}

/**
 * The field roster (layer 4 task A; DSP-02, PER-01, FR-05.06, FL:FR-13): a team or
 * unit with its members as personnel records (no contact details: the seed never
 * invents a phone that could be dialled) and their credentials, recorded and verified
 * by the seed actor; the team starts available. Re-runs skip teams that exist.
 */
async function ensureRoster(
  trx: Transaction<Database>,
  tenantId: string,
  tenantName: string,
  specs: TeamSpec[],
): Promise<void> {
  const event = await trx
    .selectFrom('cg.event')
    .select('id')
    .where('tenant_id', '=', tenantId)
    .where('intake_slug', '=', 'westwind')
    .executeTakeFirst();
  for (const spec of specs) {
    const existing = await trx
      .selectFrom('cg.team')
      .select('id')
      .where('tenant_id', '=', tenantId)
      .where('key', '=', spec.key)
      .executeTakeFirst();
    if (existing) continue;
    const team = await trx
      .insertInto('cg.team')
      .values({
        tenant_id: tenantId,
        event_id: event?.id ?? null,
        key: spec.key,
        name: spec.name,
        kind: spec.kind,
        agency_tenant_id: tenantId,
        agency: spec.agency ?? tenantName,
        callsign: spec.callsign ?? null,
        skills: spec.skills,
        equipment: spec.equipment,
        capacity: spec.members.length,
        meals_per_hour: spec.mealsPerHour ?? null,
        check_in_interval_minutes: spec.checkInIntervalMinutes,
        notes: 'Synthetic exercise roster (SCL-12)',
        created_by: SEED_ACTOR_A,
        updated_by: SEED_ACTOR_A,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    let leadId: string | null = null;
    for (const member of spec.members) {
      const person = await trx
        .insertInto('cg.personnel')
        .values({
          tenant_id: tenantId,
          name: member.name,
          agency: spec.agency ?? tenantName,
          department: spec.name,
          operational_role: member.operationalRole,
          skills: member.credentials,
          availability: 'available',
          hours_limit: member.hoursLimit,
          home_tenant_id: tenantId,
          created_by: SEED_ACTOR_A,
          updated_by: SEED_ACTOR_A,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      if (member.role === 'lead') leadId = person.id;
      for (const kind of member.credentials) {
        const expires = ['chainsaw', 'medical', 'background_check', 'food_safety'].includes(kind);
        await trx
          .insertInto('cg.credential')
          .values({
            tenant_id: tenantId,
            personnel_id: person.id,
            kind,
            label: kind.replace(/_/g, ' '),
            issuer: 'Exercise WESTWIND (synthetic)',
            issued_at: '2026-01-15',
            expires_at: expires ? '2028-01-15' : null,
            status: 'verified',
            verified_by: SEED_ACTOR_A,
            verified_at: new Date(),
            created_by: SEED_ACTOR_A,
            updated_by: SEED_ACTOR_A,
          })
          .execute();
      }
      await trx
        .insertInto('cg.team_member')
        .values({
          tenant_id: tenantId,
          team_id: team.id,
          personnel_id: person.id,
          role: member.role,
          created_by: SEED_ACTOR_A,
        })
        .execute();
    }
    if (leadId) {
      await trx
        .updateTable('cg.team')
        .set({ lead_personnel_id: leadId, updated_by: SEED_ACTOR_A })
        .where('id', '=', team.id)
        .execute();
    }
    await trx
      .insertInto('cg.team_status')
      .values({
        tenant_id: tenantId,
        team_id: team.id,
        status: 'available',
        fact: 'confirmed',
        source: 'seed',
        note: 'Roster loaded',
      })
      .execute();
  }
}

/** Tenant parcel data from the synthetic grid (FLD-04, SCL-12); loaded once per tenant. */
async function ensureParcels(trx: Transaction<Database>, tenantId: string): Promise<void> {
  const count = await trx
    .selectFrom('cg.parcel')
    .select((eb) => eb.fn.countAll<string>().as('n'))
    .where('tenant_id', '=', tenantId)
    .executeTakeFirstOrThrow();
  if (Number(count.n) > 0) return;
  const features = buildCounty(2026, 0).parcels.features;
  const chunk = 100;
  for (let i = 0; i < features.length; i += chunk) {
    await trx
      .insertInto('cg.parcel')
      .values(
        features.slice(i, i + chunk).map((f) => {
          const [line1, city] = f.properties.address.split(', ');
          return {
            tenant_id: tenantId,
            parcel_id: f.properties.parcelId,
            geom: sql`ST_SetSRID(ST_GeomFromGeoJSON(${JSON.stringify(f.geometry)}), 4326)`,
            line1: line1 ?? null,
            city: city ?? null,
            postal:
              zipCentroids.find((z) => z.name.toLowerCase().replace(' ', '-') === f.properties.area)
                ?.postal ?? null,
            structure: f.properties.structure,
            unit_count: f.properties.unitCount,
            area_key: f.properties.area,
            source: 'seed',
            created_by: SEED_ACTOR_A,
            updated_by: SEED_ACTOR_A,
          };
        }),
      )
      .execute();
  }
}

/**
 * The opaque reference of the exercise mission linked to the CJIS enclave (layer 5,
 * SEC-12). Real links get a random reference (routes/missions.ts newCjiRef); this one is
 * fixed so the enclave's exercise data (services/cjis-api/src/provision/exercise.ts) can
 * hold a record for it without the two systems ever talking to each other.
 */
export const EXERCISE_CJI_REF = 'WESTWIND-EXERCISE-CJIS-LINK-000000000000100';

/**
 * One exercise mission with law-enforcement involvement, linked to the enclave by the
 * liaison (layer 5). The platform side says nothing about the criminal-justice details:
 * the summary is operational only; the details are in the enclave's exercise record.
 * Loaded once.
 */
async function ensureCjisExercise(
  trx: Transaction<Database>,
  tenantId: string,
  accountIds: Record<string, string>,
): Promise<void> {
  const linked = await trx
    .selectFrom('cg.mission')
    .select('id')
    .where('cji_ref', '=', EXERCISE_CJI_REF)
    .executeTakeFirst();
  if (linked) return;
  const event = await trx
    .selectFrom('cg.event')
    .select('id')
    .where('tenant_id', '=', tenantId)
    .where('intake_slug', '=', 'westwind')
    .executeTakeFirst();
  if (!event) return;
  const liaison = accountIds['liaison@example.org'] ?? null;
  const ref = await sql<{
    r: string;
  }>`select cg.next_mission_reference(${tenantId}::uuid) as r`.execute(trx);
  const now = new Date();
  const mission = await trx
    .insertInto('cg.mission')
    .values({
      tenant_id: tenantId,
      event_id: event.id,
      reference: ref.rows[0]!.r,
      kind: 'other',
      subcategory: 'law_enforcement_support',
      state: 'open',
      priority: 'high',
      urgency: 'soon',
      source: 'staff',
      summary: 'Law-enforcement support at the Commercial Row distribution point',
      owning_tenant_id: tenantId,
      opened_at: now,
      cji_ref: EXERCISE_CJI_REF,
      cji_linked_at: now,
      cji_linked_by: liaison,
      created_by: liaison,
      updated_by: liaison,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  await trx
    .insertInto('cg.mission_event')
    .values({
      tenant_id: tenantId,
      mission_id: mission.id,
      kind: 'created',
      narrative_role: 'system',
      actor_account_id: liaison,
      detail: JSON.stringify({ cjis: 'linked', exercise: true }),
    })
    .execute();
}

/**
 * Exercise missions (layer 4 task B; MIS-01–04, RULE-03, CALL-01, DSP-02/10/11):
 * four verification routes assigned to the damage assessment teams (assigned only:
 * no dispatch, no arrival is inferred, AC-06B), a traffic-control mission dispatched
 * to the Guard unit by radio without proof of delivery yet, a site-staffing mission
 * and a cleanup work order in the queue, and a welfare check from a call. The seed
 * holds no keys, so the caller block stays empty; the console fills it. Job aids
 * are exercise drafts until the county approves them (FL-15). Loaded once.
 */
async function ensureMissions(
  trx: Transaction<Database>,
  tenantId: string,
  tenantIds: Record<string, string>,
  accountIds: Record<string, string>,
): Promise<void> {
  const event = await trx
    .selectFrom('cg.event')
    .select('id')
    .where('tenant_id', '=', tenantId)
    .where('intake_slug', '=', 'westwind')
    .executeTakeFirst();
  if (!event) return;
  const existing = await trx
    .selectFrom('cg.mission')
    .select('id')
    .where('tenant_id', '=', tenantId)
    .where('event_id', '=', event.id)
    .limit(1)
    .executeTakeFirst();
  if (existing) return;
  const teams = await trx
    .selectFrom('cg.team')
    .select(['id', 'key', 'lead_personnel_id'])
    .where('tenant_id', '=', tenantId)
    .execute();
  const teamByKey = new Map(teams.map((t) => [t.key, t]));
  const gym = await trx
    .selectFrom('cg.site')
    .select('id')
    .where('tenant_id', '=', tenantId)
    .where('slug', '=', 'harmon-high-gym')
    .executeTakeFirst();
  const dispatcher = accountIds['priya.assessment@example.org'] ?? null;
  const now = Date.now();

  const create = async (spec: {
    kind: MissionKind;
    state: 'draft' | 'open';
    priority: 'low' | 'normal' | 'high' | 'urgent';
    urgency: 'routine' | 'soon' | 'now';
    source: 'need' | 'report' | 'call' | 'walk_in' | 'field' | 'staff' | 'board';
    summary: string;
    siteId?: string | null;
    owningTenantId?: string | null;
    requiredCredentials?: string[];
    route?: unknown;
    interpreter?: boolean;
    language?: string | null;
    location?: { area: string; lon: number; lat: number } | null;
  }) => {
    const ref = await sql<{
      r: string;
    }>`select cg.next_mission_reference(${tenantId}::uuid) as r`.execute(trx);
    let locationId: string | null = null;
    if (spec.location) {
      const loc = await trx
        .insertInto('cg.location')
        .values({
          tenant_id: tenantId,
          landmark: spec.location.area,
          geom: sql`ST_SetSRID(ST_MakePoint(${spec.location.lon}, ${spec.location.lat}), 4326)`,
          precision: 'area',
          source: 'reviewer',
          created_by: SEED_ACTOR_A,
          updated_by: SEED_ACTOR_A,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      locationId = loc.id;
    }
    const mission = await trx
      .insertInto('cg.mission')
      .values({
        tenant_id: tenantId,
        event_id: event.id,
        reference: ref.rows[0]!.r,
        kind: spec.kind,
        state: spec.state,
        priority: spec.priority,
        urgency: spec.urgency,
        source: spec.source,
        summary: spec.summary,
        caller_language: spec.language ?? null,
        interpreter_needed: spec.interpreter ?? false,
        location_id: locationId,
        location_state: locationId ? 'approximate' : 'unknown',
        site_id: spec.siteId ?? null,
        owning_tenant_id: spec.owningTenantId ?? tenantId,
        required_credentials: spec.requiredCredentials ?? [],
        route: spec.route === undefined ? null : JSON.stringify(spec.route),
        opened_at: spec.state === 'open' ? new Date(now) : null,
        created_by: dispatcher,
        updated_by: dispatcher,
      })
      .returning(['id', 'reference'])
      .executeTakeFirstOrThrow();
    await trx
      .insertInto('cg.mission_event')
      .values([
        {
          tenant_id: tenantId,
          mission_id: mission.id,
          kind: 'created',
          narrative_role: 'dispatcher',
          to_state: 'draft',
          actor_account_id: dispatcher,
          body: 'Created by the exercise seed (synthetic, SCL-12).',
        },
        ...(spec.state === 'open'
          ? [
              {
                tenant_id: tenantId,
                mission_id: mission.id,
                kind: 'state_changed' as const,
                narrative_role: 'dispatcher' as const,
                from_state: 'draft',
                to_state: 'open',
                actor_account_id: dispatcher,
                reason: 'Dispatch prerequisites met',
              },
            ]
          : []),
      ])
      .execute();
    if (spec.state === 'open') {
      await trx
        .insertInto('cg.significant_event')
        .values({
          tenant_id: tenantId,
          event_id: event.id,
          kind: 'mission_opened',
          summary: `${mission.reference} opened: ${spec.summary}`,
          mission_id: mission.id,
          actor_account_id: dispatcher,
        })
        .execute();
    }
    return mission;
  };

  const assignTeam = async (
    missionId: string,
    teamKey: string,
    dispatch?: { method: 'app' | 'text' | 'radio' | 'phone' | 'in_person' },
  ) => {
    const team = teamByKey.get(teamKey);
    if (!team) return;
    const assignment = await trx
      .insertInto('cg.assignment')
      .values({
        tenant_id: tenantId,
        mission_id: missionId,
        resource_kind: 'team',
        team_id: team.id,
        state: dispatch ? 'dispatched' : 'assigned',
        assigned_by: dispatcher,
        dispatched_at: dispatch ? new Date(now) : null,
        dispatched_by: dispatch ? dispatcher : null,
        dispatch_method: dispatch?.method ?? null,
        created_by: dispatcher,
        updated_by: dispatcher,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    await trx
      .insertInto('cg.assignment_event')
      .values([
        {
          tenant_id: tenantId,
          assignment_id: assignment.id,
          kind: 'assigned',
          to_state: 'assigned',
          actor_account_id: dispatcher,
        },
        ...(dispatch
          ? [
              {
                tenant_id: tenantId,
                assignment_id: assignment.id,
                kind: 'dispatched' as const,
                from_state: 'assigned',
                to_state: 'dispatched',
                method: dispatch.method,
                actor_account_id: dispatcher,
              },
            ]
          : []),
      ])
      .execute();
    await trx
      .insertInto('cg.activity_entry')
      .values({
        tenant_id: tenantId,
        event_id: event.id,
        team_id: team.id,
        kind: dispatch ? 'dispatched' : 'assigned',
        summary: dispatch
          ? `Dispatched by ${dispatch.method}; awaiting acknowledgement`
          : 'Assigned; not yet dispatched',
        ref_kind: 'assignment',
        ref_id: assignment.id,
        actor_account_id: dispatcher,
      })
      .execute();
  };

  const areas: Record<string, { lon: number; lat: number }> = {
    'willow-bend': { lon: -90.905, lat: 38.79 },
    'cedar-ridge': { lon: -90.87, lat: 38.795 },
    'prairie-lakes': { lon: -90.835, lat: 38.8 },
    'oak-hollow': { lon: -90.815, lat: 38.805 },
  };
  let n = 0;
  for (const area of Object.keys(areas)) {
    n += 1;
    const m = await create({
      kind: 'verification_route',
      state: 'open',
      priority: area === 'willow-bend' || area === 'cedar-ridge' ? 'high' : 'normal',
      urgency: 'soon',
      source: 'staff',
      summary: `Verification route ${n}: ${area.replace('-', ' ')} (no-photo reports first)`,
      requiredCredentials: ['damage_assessor'],
      route: { area, order: 'no_photo_first', stops: [] },
      location: { area, ...areas[area]! },
    });
    await assignTeam(m.id, `da-${n}`);
  }
  const traffic = await create({
    kind: 'traffic_control',
    state: 'open',
    priority: 'high',
    urgency: 'now',
    source: 'board',
    summary: 'Traffic control at Route 94 and Willow Bend entrance; closed road ahead',
    requiredCredentials: ['driver_cdl'],
    location: { area: 'willow-bend', ...areas['willow-bend']! },
  });
  await assignTeam(traffic.id, 'guard-tc-1', { method: 'radio' });
  await trx
    .insertInto('cg.comms_log')
    .values({
      tenant_id: tenantId,
      event_id: event.id,
      net: 'County ARES net',
      from_station: 'NET',
      to_station: 'TC-1',
      team_id: teamByKey.get('guard-tc-1')?.id ?? null,
      kind: 'traffic',
      message: `${traffic.reference} passed to TC-1 by radio; acknowledgement pending`,
      operator_account_id: dispatcher,
    })
    .execute();
  await create({
    kind: 'site_staffing',
    state: 'open',
    priority: 'normal',
    urgency: 'soon',
    source: 'staff',
    summary: 'Harmon High School gym: two more shelter workers for the night shift',
    siteId: gym?.id ?? null,
    requiredCredentials: ['shelter_management'],
  });
  await create({
    kind: 'cleanup_work_order',
    state: 'draft',
    priority: 'normal',
    urgency: 'routine',
    source: 'need',
    summary: 'Tree on a driveway in Oak Hollow; right of entry still to be signed',
    owningTenantId: tenantIds['cleanup'] ?? null,
    requiredCredentials: ['chainsaw'],
    location: { area: 'oak-hollow', ...areas['oak-hollow']! },
  });
  const welfare = await create({
    kind: 'welfare_check',
    state: 'open',
    priority: 'urgent',
    urgency: 'now',
    source: 'call',
    summary: 'Caller asks for a check on a neighbour who depends on powered medical equipment',
    interpreter: true,
    language: 'es',
    location: { area: 'cedar-ridge', ...areas['cedar-ridge']! },
  });
  const hazard = await trx
    .insertInto('cg.hazard')
    .values({
      tenant_id: tenantId,
      event_id: event.id,
      mission_id: welfare.id,
      kind: 'downed_line',
      state: 'reported',
      severity: 'danger',
      summary: 'Downed line reported across the entrance road (unconfirmed)',
      geom: sql`ST_SetSRID(ST_MakePoint(-90.871, 38.7955), 4326)`,
      radius_m: 50,
      source: 'call',
      reported_by: dispatcher,
      created_by: dispatcher,
      updated_by: dispatcher,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  await trx
    .insertInto('cg.hazard_event')
    .values({
      tenant_id: tenantId,
      hazard_id: hazard.id,
      kind: 'reported',
      to_state: 'reported',
      actor_account_id: dispatcher,
    })
    .execute();
  const reminder = await trx
    .insertInto('cg.reminder')
    .values({
      tenant_id: tenantId,
      event_id: event.id,
      kind: 'call_back',
      title: `Call the caller back about ${welfare.reference}`,
      owner_account_id: dispatcher,
      mission_id: welfare.id,
      subject_kind: 'mission',
      subject_id: welfare.id,
      due_at: new Date(now + 2 * 3_600_000),
      escalate_to_role: 'field_coordinator',
      escalate_after_minutes: 30,
      created_by: dispatcher,
      updated_by: dispatcher,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  await trx
    .insertInto('cg.reminder_event')
    .values({
      tenant_id: tenantId,
      reminder_id: reminder.id,
      kind: 'created',
      actor_account_id: dispatcher,
    })
    .execute();
}

/** Job aids per role and language, marked as exercise drafts until the county approves them (FL-15). */
async function ensureJobAids(trx: Transaction<Database>, tenantId: string): Promise<void> {
  const aids = [
    {
      key: 'fema-damage-matrix',
      roleKey: 'damage_assessor',
      kind: 'matrix' as const,
      text: {
        en: {
          title: 'FEMA degree of damage: what to look for',
          body: '<h2>Pick from pictures and short descriptions</h2><ul><li><strong>Affected:</strong> cosmetic damage; the home is livable.</li><li><strong>Minor:</strong> repairable damage; livable with repairs.</li><li><strong>Major:</strong> structural damage; not livable without extensive repairs.</li><li><strong>Destroyed:</strong> total loss or not repairable.</li></ul><p>Choose from the pictures for the home type, never from these words alone.</p>',
        },
        es: {
          title: 'Grado de daño de FEMA: qué observar',
          body: '<h2>Elija a partir de fotos y descripciones cortas</h2><ul><li><strong>Afectada:</strong> daño cosmético; la vivienda es habitable.</li><li><strong>Menor:</strong> daño reparable; habitable con reparaciones.</li><li><strong>Mayor:</strong> daño estructural; no habitable sin reparaciones extensas.</li><li><strong>Destruida:</strong> pérdida total o no reparable.</li></ul><p>Elija a partir de las fotos del tipo de vivienda, nunca solo con estas palabras.</p>',
        },
      },
    },
    {
      key: 'shelter-standards',
      roleKey: 'shelter_worker',
      kind: 'standard' as const,
      text: {
        en: {
          title: 'Shelter standards checklist',
          body: '<ul><li>40 square feet per person; clear aisles.</li><li>Accessible cots and a quiet area.</li><li>Pets in a separate, ventilated space.</li><li>Dietary and access needs recorded at the door, never on a public list.</li></ul>',
        },
        es: {
          title: 'Lista de normas del albergue',
          body: '<ul><li>40 pies cuadrados por persona; pasillos despejados.</li><li>Catres accesibles y una zona tranquila.</li><li>Mascotas en un espacio separado y ventilado.</li><li>Necesidades dietéticas y de acceso registradas en la entrada, nunca en una lista pública.</li></ul>',
        },
      },
    },
    {
      key: 'safety-briefing',
      roleKey: null,
      kind: 'briefing' as const,
      text: {
        en: {
          title: 'Field safety briefing',
          body: '<ul><li>Check in before you start; your lead answers the timer every hour.</li><li>Downed lines are live until the utility says otherwise.</li><li>Do not enter a structure marked unsafe.</li><li>The help button sends your position to dispatch at once.</li><li>If this is an emergency, call 911.</li></ul>',
        },
        es: {
          title: 'Instrucciones de seguridad en campo',
          body: '<ul><li>Regístrese antes de empezar; su líder responde al temporizador cada hora.</li><li>Los cables caídos tienen corriente hasta que la compañía diga lo contrario.</li><li>No entre en una estructura marcada como insegura.</li><li>El botón de ayuda envía su posición al despacho de inmediato.</li><li>Si es una emergencia, llame al 911.</li></ul>',
        },
      },
    },
  ];
  for (const aid of aids) {
    for (const lang of ['en', 'es'] as const) {
      await trx
        .insertInto('cg.job_aid')
        .values({
          tenant_id: tenantId,
          key: aid.key,
          role_key: aid.roleKey,
          lang,
          kind: aid.kind,
          title: aid.text[lang].title,
          body_html: aid.text[lang].body,
          status: 'exercise_draft',
          created_by: SEED_ACTOR_A,
          updated_by: SEED_ACTOR_A,
        })
        .onConflict((oc) => oc.columns(['tenant_id', 'key', 'lang']).doNothing())
        .execute();
    }
  }
}

/**
 * CON-13: two exercise resource requests to the state (ICS 213 RR) for the WESTWIND event, so
 * the screen, the forms and the state API have something to show: one placed with the state
 * and en route under an invented tracking number, one submitted and waiting for approval. Each
 * step is in the history. Synthetic throughout (SCL-12). Added once.
 */
async function ensureResourceRequests(
  trx: Transaction<Database>,
  tenantId: string,
  accountIds: Record<string, string>,
): Promise<void> {
  const event = await trx
    .selectFrom('cg.event')
    .select('id')
    .where('tenant_id', '=', tenantId)
    .where('intake_slug', '=', 'westwind')
    .executeTakeFirst();
  if (!event) return;
  const existing = await trx
    .selectFrom('cg.resource_request')
    .select('id')
    .where('tenant_id', '=', tenantId)
    .where('event_id', '=', event.id)
    .limit(1)
    .executeTakeFirst();
  if (existing) return;
  const who = (email: string) => accountIds[email] ?? SEED_ACTOR_A;
  const luis = who('luis.masscare@example.org');
  const dana = who('dana.director@example.org');
  const casey = who('casey.dispatch@example.org');
  const marcus = who('marcus.gis@example.org');
  const h = 3_600_000;
  const t0 = Date.now() - 20 * h;
  const requests = [
    {
      request_number: 'WESTWIND-RR-0001',
      status: 'en_route' as const,
      priority: 'urgent' as const,
      delivery_location: 'Harmon High School gym (shelter), loading dock',
      requested_by_name: 'Luis Ortega (exercise)',
      requested_by_position: 'Mass Care Coordinator',
      substitutes: 'Folding camp beds acceptable in place of cots.',
      suggested_sources: 'State logistics warehouse; Red Cross regional chapter.',
      notes: 'Shelter at 180 of 220 after the second night; more arrivals expected.',
      cost_estimate: 18_400,
      finance_reply: 'Approved against the shelter operations line (exercise).',
      finance_replied_at: new Date(t0 + 2 * h),
      finance_replied_by: dana,
      submitted_at: new Date(t0 + h),
      submitted_by: luis,
      approved_at: new Date(t0 + 3 * h),
      approved_by: dana,
      placed_at: new Date(t0 + 4 * h),
      placed_by: casey,
      placed_with: 'state' as const,
      state_tracking_number: 'SEMA-EX-4471',
      eta: new Date(t0 + 30 * h),
      created_by: luis,
      lines: [
        {
          quantity: 200,
          unit: 'each',
          kind: 'Cots',
          type: 'Standard shelter cot',
          description: 'For the Harmon High shelter',
        },
        {
          quantity: 400,
          unit: 'each',
          kind: 'Blankets',
          type: 'Wool or fleece',
          description: null,
        },
        {
          quantity: 2,
          unit: 'pallets',
          kind: 'Hygiene kits',
          type: 'Adult',
          description: '48 per case',
        },
      ],
      steps: [
        ['drafted', null, 'draft', null, luis, t0],
        [
          'submitted',
          'draft',
          'submitted',
          'Shelter near capacity; cots and blankets short for a third night',
          luis,
          t0 + h,
        ],
        [
          'finance_replied',
          'submitted',
          'submitted',
          'Approved against the shelter operations line (exercise).',
          dana,
          t0 + 2 * h,
        ],
        [
          'approved',
          'submitted',
          'approved',
          'Confirmed with the shelter manager',
          dana,
          t0 + 3 * h,
        ],
        ['placed', 'approved', 'placed', 'Placed with state logistics', casey, t0 + 4 * h],
        ['en_route', 'placed', 'en_route', null, casey, t0 + 9 * h],
      ] as const,
    },
    {
      request_number: 'WESTWIND-RR-0002',
      status: 'submitted' as const,
      priority: 'high' as const,
      delivery_location: 'Commercial Row distribution point',
      requested_by_name: 'Marcus Bell (exercise)',
      requested_by_position: 'Planning Section Chief',
      substitutes: null,
      suggested_sources: 'State public works fleet.',
      notes: 'Power out along Commercial Row; the distribution point runs on one small generator.',
      cost_estimate: 6_000,
      finance_reply: null,
      finance_replied_at: null,
      finance_replied_by: null,
      submitted_at: new Date(t0 + 6 * h),
      submitted_by: marcus,
      approved_at: null,
      approved_by: null,
      placed_at: null,
      placed_by: null,
      placed_with: null,
      state_tracking_number: null,
      eta: null,
      created_by: marcus,
      lines: [
        {
          quantity: 4,
          unit: 'each',
          kind: 'Generators',
          type: 'Towable, 20 kW',
          description: 'With fuel for 72 hours',
        },
        { quantity: 8, unit: 'each', kind: 'Light towers', type: 'Towable', description: null },
      ],
      steps: [
        ['drafted', null, 'draft', null, marcus, t0 + 5 * h],
        [
          'submitted',
          'draft',
          'submitted',
          'Distribution point cannot run after dark',
          marcus,
          t0 + 6 * h,
        ],
      ] as const,
    },
  ];
  for (const spec of requests) {
    const { lines, steps, ...row } = spec;
    const r = await trx
      .insertInto('cg.resource_request')
      .values({ ...row, tenant_id: tenantId, event_id: event.id, updated_by: row.created_by })
      .returning('id')
      .executeTakeFirstOrThrow();
    await trx
      .insertInto('cg.resource_request_line')
      .values(
        lines.map((l, i) => ({
          ...l,
          tenant_id: tenantId,
          request_id: r.id,
          line_no: i + 1,
          created_by: row.created_by,
          updated_by: row.created_by,
        })),
      )
      .execute();
    await trx
      .insertInto('cg.resource_request_step')
      .values(
        steps.map(([step, from, to, reason, actor, at]) => ({
          tenant_id: tenantId,
          request_id: r.id,
          step,
          from_status: from,
          to_status: to,
          reason,
          occurred_at: new Date(at),
          actor_account_id: actor,
          created_by: actor,
          updated_by: actor,
        })),
      )
      .execute();
  }
}

/**
 * SCL-10: the exercise subscriptions (invented terms and tiers). The state's coalition contract
 * covers its member jurisdictions; Westwind's own earlier contract has expired, so the
 * Subscription screen shows both, and resident reports go on regardless. Added once.
 */
async function ensureLicenses(db: Kysely<Database>, tenantIds: Record<string, string>) {
  const contracts = [
    {
      holder: 'state',
      tier: 'State coalition (exercise)',
      population_served: 6_100_000,
      term_start: '2026-07-01',
      term_end: '2027-06-30',
      covers: ['region', 'county', 'city'],
      status: 'active' as const,
    },
    {
      holder: 'county',
      tier: 'County, 25,000 to 100,000 people (exercise)',
      population_served: 48_000,
      term_start: '2025-07-01',
      term_end: '2026-06-30',
      covers: ['city'],
      status: 'expired' as const,
    },
  ];
  for (const c of contracts) {
    const holder = tenantIds[c.holder];
    if (!holder) continue;
    await withTenant(db, { tenantId: holder }, async (trx) => {
      const existing = await trx
        .selectFrom('cg.license')
        .select('id')
        .where('tenant_id', '=', holder)
        .where(sql<boolean>`term_start = ${c.term_start}::date`)
        .executeTakeFirst();
      if (existing) return;
      await trx
        .insertInto('cg.license')
        .values({
          tenant_id: holder,
          tier: c.tier,
          population_served: c.population_served,
          term_start: c.term_start,
          term_end: c.term_end,
          covers_tenant_ids: c.covers.map((k) => tenantIds[k]).filter((x): x is string => !!x),
          status: c.status,
          created_by: SEED_ACTOR_A,
        })
        .execute();
    });
  }
}

export async function loadSeed(db: Kysely<Database>): Promise<Loaded> {
  const tenantIds: Record<string, string> = {};
  const accountIds: Record<string, string> = {};

  // Hierarchy in dependency order (parents first, as listed in county.ts).
  for (const spec of tenantSpecs) {
    const parentId = spec.parent ? (tenantIds[spec.parent] ?? null) : null;
    const { id, created } = await ensureTenant(db, spec, parentId);
    tenantIds[spec.key] = id;
    await withTenant(db, { tenantId: id }, async (trx) => {
      await ensureRetentionDefaults(trx, id);
      if (spec.fips || spec.outline) {
        const geom = spec.outline
          ? sql`ST_Multi(ST_MakeEnvelope(${spec.outline[0]}, ${spec.outline[1]}, ${spec.outline[2]}, ${spec.outline[3]}, 4326))`
          : null;
        await trx
          .insertInto('cg.jurisdiction')
          .values({ tenant_id: id, fips: spec.fips ?? null, geom })
          .onConflict((oc) =>
            oc.column('tenant_id').doUpdateSet({
              fips: sql`coalesce(cg.jurisdiction.fips, excluded.fips)`,
              geom: sql`coalesce(cg.jurisdiction.geom, excluded.geom)`,
            }),
          )
          .execute();
      }
      await ensureTemplateRoles(trx, id);
      await ensureIntakeGraph(trx, id, westwindGraph);
      // ADR-0043: OpenAI for every AI function, off until the tenant's languages pass the evaluation.
      await ensureAiRegister(trx, id, openAIDescriptor(), null);
      if (spec.key === 'county') {
        await ensureEventTemplates(trx, id);
        await ensureExerciseEvent(trx, id);
        await ensureChannelNumber(trx, id);
        await ensureZipCentroids(trx, id);
        await ensureSites(trx, id);
        await ensureFacilities(trx, id);
        await ensureResources(trx, id);
        await ensureParcels(trx, id);
      }
      await ensureRoster(
        trx,
        id,
        spec.name,
        teamSpecs.filter((t) => t.tenant === spec.key),
      );
      if (created) {
        await trx
          .insertInto('cg.outbox')
          .values({
            tenant_id: id,
            topic: 'tenant.provision',
            payload: JSON.stringify({ tenantId: id }),
            execution_id: randomUUID(),
          })
          .execute();
        await sql`insert into cg.audit_event (tenant_id, actor_kind, action, target_type, target_id, reason)
                  values (${id}::uuid, 'system', 'seed.tenant', 'tenant', ${id}, 'synthetic WESTWIND seed')`.execute(
          trx,
        );
      }
    });
  }

  await ensureLicenses(db, tenantIds);

  for (const member of cast) {
    const tenantId = tenantIds[member.tenant];
    if (!tenantId)
      throw new Error(`cast member ${member.email} names unknown tenant ${member.tenant}`);
    await withTenant(db, { tenantId }, async (trx) => {
      const role = await trx
        .selectFrom('cg.role')
        .select('id')
        .where('tenant_id', '=', tenantId)
        .where('key', '=', member.role)
        .executeTakeFirstOrThrow();
      const { id } = await ensureAccount(trx, tenantId, member, role.id);
      accountIds[member.email] = id;
    });
  }
  // A field account is the roster person it names (FLD-03): its check-in is that person's.
  for (const link of FIELD_ACCOUNTS) {
    const accountId = accountIds[link.email];
    const spec = teamSpecs.find((t) => t.key === link.team);
    const tenantId = spec ? tenantIds[spec.tenant] : undefined;
    if (!accountId || !spec || !tenantId) continue;
    await withTenant(db, { tenantId }, async (trx) => {
      const person = await trx
        .selectFrom('cg.team_member as m')
        .innerJoin('cg.team as t', 't.id', 'm.team_id')
        .innerJoin('cg.personnel as p', 'p.id', 'm.personnel_id')
        .select(['p.id', 'p.account_id'])
        .where('t.key', '=', link.team)
        .where('m.role', '=', link.member)
        .executeTakeFirst();
      if (person && !person.account_id)
        await trx
          .updateTable('cg.personnel')
          .set({ account_id: accountId, updated_by: SEED_ACTOR_A })
          .where('id', '=', person.id)
          .execute(); // Field roles read missions only in the events they are assigned to (events: 'assigned');
      // the exercise lead works the WESTWIND exercise, so a held job opens by id (CMD-06).
      const exercise = await trx
        .selectFrom('cg.event')
        .select('id')
        .where('tenant_id', '=', tenantId)
        .where('intake_slug', '=', 'westwind')
        .executeTakeFirst();
      if (exercise)
        await trx
          .updateTable('cg.role_assignment')
          .set({ scope: JSON.stringify({ eventIds: [exercise.id] }), updated_by: SEED_ACTOR_B })
          .where('account_id', '=', accountId)
          .where(sql<boolean>`scope = '{}'::jsonb`)
          .execute();
    });
  }
  const countyId = tenantIds['county'];
  if (countyId) {
    await withTenant(db, { tenantId: countyId }, async (trx) => {
      await ensureAgreements(trx, countyId, tenantIds);
      await ensureJobAids(trx, countyId);
      await ensureMissions(trx, countyId, tenantIds, accountIds);
      await ensureResourceRequests(trx, countyId, accountIds);
      await ensureCjisExercise(trx, countyId, accountIds);
    });
  }
  return { tenants: tenantIds, accounts: accountIds };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const url = process.env['DATABASE_URL'];
  if (!url) {
    console.error('DATABASE_URL (cg_worker role) is not set');
    process.exit(2);
  }
  const db = createDb(url, 2);
  const loaded = await loadSeed(db);
  // Opt-in (layer 6): reviewed damage reports in the exercise event, for the counting rule,
  // the declaration view and official reports. Off by default: other suites expect an
  // empty review queue. Loaded once; a second run with the setting finds them and stops.
  const damageCount = Number(process.env['SEED_DAMAGE_REPORTS'] ?? 0);
  if (Number.isInteger(damageCount) && damageCount > 0) {
    const countyId = loaded.tenants['county']!;
    const already = await withTenant(db, { tenantId: countyId }, (trx) =>
      trx
        .selectFrom('cg.report')
        .select('id')
        .where('reference_code', 'like', 'SYN-seed-%')
        .executeTakeFirst(),
    );
    if (!already) {
      const event = await withTenant(db, { tenantId: countyId }, (trx) =>
        trx
          .selectFrom('cg.event')
          .select('id')
          .where('intake_slug', '=', 'westwind')
          .executeTakeFirstOrThrow(),
      );
      const filed = await loadDamageReports(db, {
        tenantId: countyId,
        eventId: event.id,
        reviewerId: loaded.accounts['priya.assessment@example.org']!,
        count: Math.min(damageCount, 50_000),
        tag: 'seed',
      });
      console.log(
        JSON.stringify({ msg: 'damage reports loaded', reports: filed.reportIds.length }),
      );
    }
  }
  await db.destroy();
  console.log(
    JSON.stringify({
      msg: 'seed loaded',
      tenants: Object.keys(loaded.tenants).length,
      accounts: Object.keys(loaded.accounts).length,
    }),
  );
}
