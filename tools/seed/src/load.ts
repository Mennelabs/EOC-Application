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
import { createDb, withTenant, type Database } from '@cg/db';
import { evaluateProvider, fakeProvider } from '@cg/ai';
import { westwindGraph } from '@cg/intake';
import {
  ensureAiRegister,
  ensureIntakeGraph,
  ensureRetentionDefaults,
  ensureTemplateRoles,
} from '@cg/provisioning';
import type { Kysely, Transaction } from 'kysely';
import {
  tenants as tenantSpecs,
  agreements as agreementSpecs,
  resources as resourceSpecs,
  sites as siteSpecs,
  teams as teamSpecs,
  zipCentroids,
  buildCounty,
  EXERCISE_CHECK_IN_CODE,
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
  // Partner organizations run their own accounts (ADM-02, decision 2026-10-13). Each gets
  // a tenant administrator and a security administrator, because granting a role needs a
  // second administrator inside the same organization (ADM-05 G6).
  ...(['coad', 'canteen', 'shelter-ngo', 'cleanup', 'legal'] as const).flatMap((tenant) => [
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
  ]),
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

export async function loadSeed(db: Kysely<Database>): Promise<Loaded> {
  const tenantIds: Record<string, string> = {};
  const evaluation = await evaluateProvider(fakeProvider);
  const accountIds: Record<string, string> = {};

  // Hierarchy in dependency order (parents first, as listed in county.ts).
  for (const spec of tenantSpecs) {
    const parentId = spec.parent ? (tenantIds[spec.parent] ?? null) : null;
    const { id, created } = await ensureTenant(db, spec, parentId);
    tenantIds[spec.key] = id;
    await withTenant(db, { tenantId: id }, async (trx) => {
      await ensureRetentionDefaults(trx, id);
      await ensureTemplateRoles(trx, id);
      await ensureIntakeGraph(trx, id, westwindGraph);
      await ensureAiRegister(trx, id, fakeProvider, evaluation);
      if (spec.key === 'county') {
        await ensureExerciseEvent(trx, id);
        await ensureChannelNumber(trx, id);
        await ensureZipCentroids(trx, id);
        await ensureSites(trx, id);
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
  const countyId = tenantIds['county'];
  if (countyId) {
    await withTenant(db, { tenantId: countyId }, (trx) =>
      ensureAgreements(trx, countyId, tenantIds),
    );
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
  await db.destroy();
  console.log(
    JSON.stringify({
      msg: 'seed loaded',
      tenants: Object.keys(loaded.tenants).length,
      accounts: Object.keys(loaded.accounts).length,
    }),
  );
}
