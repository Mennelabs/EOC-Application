/**
 * Law-enforcement records (SEC-12, PPL-01, BRD:D02, BRD:D07,
 * BRD:FR-07.01–07.06, BRD:FR-04.01, BRD:FR-00.05/06): the CJI that belongs
 * to a platform mission, keyed by the platform's opaque reference. Every
 * read of a record is audited with the names of the fields returned; every
 * write is audited and lands on the append-only timeline. Identifying and
 * free-text values are encrypted under the agency key (SEC-10). A closed
 * record takes no new entries until a supervisor reopens it.
 */
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type { Transaction } from 'kysely';
import { z } from 'zod';
import type { CjisDatabase, RecordEventKind } from '@cg/cjis-db';
import type { Sealer } from '../crypto.ts';
import { errors, ApiError } from '../errors.ts';

const ref = z.string().regex(/^[A-Za-z0-9_-]{32,64}$/, 'an enclave reference from the console');
const text = (max: number) => z.string().trim().min(1).max(max);
const origins = [
  '911',
  'non_emergency',
  'officer_initiated',
  'walk_in',
  'text',
  'radio',
  'other',
] as const;
export const CLASSIFICATIONS = [
  'welfare_check',
  'disturbance',
  'assault',
  'theft',
  'burglary',
  'looting',
  'trespass',
  'traffic',
  'missing_person',
  'death_investigation',
  'domestic',
  'weapons_offense',
  'warrant_service',
  'other',
] as const;
export const DISPOSITIONS = [
  'arrest_made',
  'citation_issued',
  'report_filed',
  'no_action_taken',
  'transported',
  'referred',
  'completed',
] as const;
const personRoles = [
  'suspect',
  'arrestee',
  'victim',
  'witness',
  'complainant',
  'subject',
  'reporting_party',
  'other',
] as const;
const weaponKinds = ['firearm', 'edged', 'blunt', 'explosive', 'other', 'unknown'] as const;
const weaponDispositions = ['observed', 'seized', 'returned', 'unknown'] as const;

const recordFields = {
  origin: z.enum(origins).nullable().optional(),
  classification: z.enum(CLASSIFICATIONS).nullable().optional(),
  offenseCodes: z.array(z.string().trim().min(1).max(20)).max(20).optional(),
  caseNumber: text(60).nullable().optional(),
  summary: text(4000).nullable().optional(),
};
const createBody = z.object({
  ref,
  platformMissionReference: z
    .string()
    .regex(/^M-\d{5,}$/)
    .nullable()
    .optional(),
  platformCounty: z
    .string()
    .regex(/^[a-z0-9-]{1,63}$/)
    .nullable()
    .optional(),
  ...recordFields,
});
const demographics = z
  .object({
    sex: z.enum(['female', 'male', 'unknown']).optional(),
    race: text(60).optional(),
    ethnicity: text(60).optional(),
    height: text(20).optional(),
    weight: text(20).optional(),
    hair: text(30).optional(),
    eyes: text(30).optional(),
  })
  .strict();
const personFields = {
  name: text(200),
  birthDate: z.iso.date().nullable().optional(),
  demographics: demographics.nullable().optional(),
  contact: text(300).nullable().optional(),
  address: text(300).nullable().optional(),
  identifiers: text(300).nullable().optional(),
  notes: text(2000).nullable().optional(),
};
const personBody = z.object({ role: z.enum(personRoles), ...personFields });
const personPatch = z.object({
  role: z.enum(personRoles).optional(),
  ...Object.fromEntries(Object.entries(personFields).map(([k, v]) => [k, v.optional()])),
}) as unknown as z.ZodType<Partial<z.infer<typeof personBody>>>;
const weaponBody = z.object({
  kind: z.enum(weaponKinds),
  description: text(1000).nullable().optional(),
  serialNumber: text(80).nullable().optional(),
  disposition: z.enum(weaponDispositions).optional(),
  personId: z.uuid().nullable().optional(),
});
const weaponPatch = weaponBody.partial();
const bodycamBody = z
  .object({
    cameraLabel: text(80),
    officerPersonId: z.uuid().nullable().optional(),
    recordedFrom: z.iso.datetime({ offset: true }).nullable().optional(),
    recordedTo: z.iso.datetime({ offset: true }).nullable().optional(),
    evidenceReference: text(300),
    notes: text(2000).nullable().optional(),
  })
  .refine((b) => !b.recordedFrom || !b.recordedTo || b.recordedTo >= b.recordedFrom, {
    message: 'the recording ends after it starts',
    path: ['recordedTo'],
  });
const bodycamPatch = z.object({
  cameraLabel: text(80).optional(),
  officerPersonId: z.uuid().nullable().optional(),
  recordedFrom: z.iso.datetime({ offset: true }).nullable().optional(),
  recordedTo: z.iso.datetime({ offset: true }).nullable().optional(),
  evidenceReference: text(300).optional(),
  notes: text(2000).nullable().optional(),
});
const removeBody = z.object({ reason: text(500) });

type Trx = Transaction<CjisDatabase>;

interface RecordRow {
  id: string;
  agency_id: string;
  cji_ref: string;
  state: 'open' | 'closed';
  version: number;
  disposition_by: string | null;
}

declare module 'fastify' {
  interface FastifyInstance {
    sealer: Sealer;
  }
}

const recordedEntryFields = {
  person: [
    'role',
    'name',
    'birthDate',
    'demographics',
    'contact',
    'address',
    'identifiers',
    'notes',
  ],
  weapon: ['kind', 'description', 'serialNumber', 'disposition'],
  bodycam: ['cameraLabel', 'recordedFrom', 'recordedTo', 'evidenceReference', 'notes'],
};

/**
 * The record by its reference as row security shows it: the agency's own, or one another
 * agency shares with it now (0006). A write names the agency that must own it; a shared record
 * is then "not found", so a helping agency never learns more than its read allows.
 */
async function loadRecord(trx: Trx, cjiRef: string, ownedBy?: string): Promise<RecordRow> {
  const row = await trx
    .selectFrom('cjis.record')
    .select(['id', 'agency_id', 'cji_ref', 'state', 'version', 'disposition_by'])
    .where('cji_ref', '=', cjiRef)
    .executeTakeFirst();
  if (!row || (ownedBy && row.agency_id !== ownedBy)) throw errors.notFound();
  return row;
}

function assertOpen(r: RecordRow): void {
  if (r.state !== 'open')
    throw new ApiError(409, 'record_closed', 'This record is closed. A supervisor can reopen it.');
}

async function event(
  trx: Trx,
  request: FastifyRequest,
  r: { id: string; agency_id: string },
  kind: RecordEventKind,
  detail: Record<string, unknown> = {},
  extra: {
    body_enc?: Buffer | null;
    narrative_role?: 'officer' | 'supervisor' | 'records' | null;
    amends_event_id?: string | null;
  } = {},
) {
  return trx
    .insertInto('cjis.record_event')
    .values({
      agency_id: r.agency_id,
      record_id: r.id,
      kind,
      actor_person_id: request.person().personId,
      detail: JSON.stringify(detail),
      body_enc: extra.body_enc ?? null,
      narrative_role: extra.narrative_role ?? null,
      amends_event_id: extra.amends_event_id ?? null,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
}

/** Bumps the record's version for a change to its entries, so a stale screen sees a conflict. */
async function touchRecord(trx: Trx, r: RecordRow, by: string) {
  await trx.updateTable('cjis.record').set({ updated_by: by }).where('id', '=', r.id).execute();
}

function changedNames(body: Record<string, unknown>): string[] {
  return Object.entries(body)
    .filter(([, v]) => v !== undefined)
    .map(([k]) => k);
}

export const recordRoutes: FastifyPluginAsync = async (appBase) => {
  const app = appBase.withTypeProvider<ZodTypeProvider>();
  const sealer = appBase.sealer;

  async function present(trx: Trx, r: RecordRow) {
    const a = r.agency_id;
    const rec = await trx
      .selectFrom('cjis.record')
      .selectAll()
      .where('id', '=', r.id)
      .executeTakeFirstOrThrow();
    const people = await trx
      .selectFrom('cjis.record_person')
      .selectAll()
      .where('record_id', '=', r.id)
      .orderBy('created_at')
      .execute();
    const weapons = await trx
      .selectFrom('cjis.record_weapon')
      .selectAll()
      .where('record_id', '=', r.id)
      .orderBy('created_at')
      .execute();
    const bodycams = await trx
      .selectFrom('cjis.record_bodycam')
      .selectAll()
      .where('record_id', '=', r.id)
      .orderBy('created_at')
      .execute();
    const events = await trx
      .selectFrom('cjis.record_event as e')
      .leftJoin('cjis.person as p', 'p.id', 'e.actor_person_id')
      .select([
        'e.id',
        'e.kind',
        'e.narrative_role',
        'e.body_enc',
        'e.amends_event_id',
        'e.detail',
        'e.occurred_at',
        'p.display_name as actor',
      ])
      .where('e.record_id', '=', r.id)
      .orderBy('e.occurred_at')
      .execute();
    const names = new Map(
      (
        await trx
          .selectFrom('cjis.person')
          .select(['id', 'display_name'])
          .where('agency_id', '=', a)
          .execute()
      ).map((p) => [p.id, p.display_name]),
    );
    return {
      ref: rec.cji_ref,
      platformMissionReference: rec.platform_mission_reference,
      platformCounty: rec.platform_county,
      origin: rec.origin,
      classification: rec.classification,
      offenseCodes: rec.offense_codes,
      caseNumber: await sealer.open(a, rec.case_number_enc),
      summary: await sealer.open(a, rec.summary_enc),
      state: rec.state,
      disposition: rec.disposition,
      dispositionNote: await sealer.open(a, rec.disposition_note_enc),
      dispositionBy: rec.disposition_by ? (names.get(rec.disposition_by) ?? null) : null,
      dispositionById: rec.disposition_by,
      dispositionAt: rec.disposition_at?.toISOString() ?? null,
      reviewedBy: rec.reviewed_by ? (names.get(rec.reviewed_by) ?? null) : null,
      reviewedAt: rec.reviewed_at?.toISOString() ?? null,
      closedAt: rec.closed_at?.toISOString() ?? null,
      version: rec.version,
      createdAt: rec.created_at.toISOString(),
      updatedAt: rec.updated_at.toISOString(),
      people: await Promise.all(
        people.map(async (p) => ({
          id: p.id,
          role: p.role,
          name: await sealer.open(a, p.name_enc),
          birthDate: await sealer.open(a, p.birth_date_enc),
          demographics: await sealer.openJson<Record<string, string>>(a, p.demographics_enc),
          contact: await sealer.open(a, p.contact_enc),
          address: await sealer.open(a, p.address_enc),
          identifiers: await sealer.open(a, p.identifiers_enc),
          notes: await sealer.open(a, p.notes_enc),
          status: p.status,
          removedReason: p.removed_reason,
          version: p.version,
        })),
      ),
      weapons: await Promise.all(
        weapons.map(async (w) => ({
          id: w.id,
          kind: w.kind,
          description: await sealer.open(a, w.description_enc),
          serialNumber: await sealer.open(a, w.serial_enc),
          disposition: w.disposition,
          personId: w.person_id,
          status: w.status,
          removedReason: w.removed_reason,
          version: w.version,
        })),
      ),
      bodycams: await Promise.all(
        bodycams.map(async (b) => ({
          id: b.id,
          cameraLabel: b.camera_label,
          officerPersonId: b.officer_person_id,
          officer: b.officer_person_id ? (names.get(b.officer_person_id) ?? null) : null,
          recordedFrom: b.recorded_from ? new Date(b.recorded_from).toISOString() : null,
          recordedTo: b.recorded_to ? new Date(b.recorded_to).toISOString() : null,
          evidenceReference: await sealer.open(a, b.evidence_reference_enc),
          notes: await sealer.open(a, b.notes_enc),
          status: b.status,
          removedReason: b.removed_reason,
          version: b.version,
        })),
      ),
      timeline: await Promise.all(
        events.map(async (e) => ({
          id: e.id,
          kind: e.kind,
          narrativeRole: e.narrative_role,
          body: await sealer.open(a, e.body_enc),
          amendsEventId: e.amends_event_id,
          detail: e.detail,
          actor: e.actor,
          at: e.occurred_at instanceof Date ? e.occurred_at.toISOString() : String(e.occurred_at),
        })),
      ),
    };
  }

  const RECORD_READ_FIELDS = [
    'origin',
    'classification',
    'offense_codes',
    'case_number',
    'summary',
    'disposition',
    'people',
    'weapons',
    'bodycams',
    'narratives',
  ];

  app.get(
    '/records',
    { schema: { querystring: z.object({ state: z.enum(['open', 'closed']).optional() }) } },
    async (request) => {
      const s = request.person();
      await request.authorize('record.list', { type: 'record', agencyId: s.agencyId });
      return request.tx(async (trx) => {
        let q = trx
          .selectFrom('cjis.record as r')
          .select((eb) => [
            'r.cji_ref',
            'r.platform_mission_reference',
            'r.platform_county',
            'r.classification',
            'r.origin',
            'r.state',
            'r.disposition',
            'r.updated_at',
            'r.version',
            eb
              .selectFrom('cjis.record_person as p')
              .select((x) => x.fn.countAll<string>().as('n'))
              .whereRef('p.record_id', '=', 'r.id')
              .where('p.status', '=', 'active')
              .as('people'),
            // Mutual aid: a record another agency shares with this one names the owner and the end.
            eb
              .selectFrom('cjis.agency as o')
              .select('o.name')
              .whereRef('o.id', '=', 'r.agency_id')
              .where('r.agency_id', '<>', s.agencyId)
              .as('shared_by'),
            eb
              .selectFrom('cjis.record_share as sh')
              .select('sh.ends_at')
              .whereRef('sh.record_id', '=', 'r.id')
              .where('sh.to_agency_id', '=', s.agencyId)
              .where('sh.status', '=', 'active')
              .orderBy('sh.ends_at', 'desc')
              .limit(1)
              .as('shared_until'),
          ])
          .orderBy('r.updated_at', 'desc')
          .limit(200);
        if (request.query.state) q = q.where('r.state', '=', request.query.state);
        const rows = await q.execute();
        await request.audit(trx, {
          action: 'record.list',
          targetType: 'record',
          targetId: '*',
          fields: ['classification', 'origin', 'disposition'],
          reason: `${rows.length} records`,
        });
        return rows.map((r) => ({
          ref: r.cji_ref,
          platformMissionReference: r.platform_mission_reference,
          platformCounty: r.platform_county,
          classification: r.classification,
          origin: r.origin,
          state: r.state,
          disposition: r.disposition,
          people: Number(r.people ?? 0),
          updatedAt: r.updated_at.toISOString(),
          version: r.version,
          sharedBy: r.shared_by ?? null,
          sharedUntil: r.shared_until ? new Date(r.shared_until).toISOString() : null,
        }));
      });
    },
  );

  app.get('/records/:ref', { schema: { params: z.object({ ref }) } }, async (request) => {
    const s = request.person();
    // The role must read records at all before the reference is looked up.
    await request.authorize(
      'record.read',
      { type: 'record', id: request.params.ref, agencyId: s.agencyId },
      { asNotFound: true },
    );
    return request.tx(async (trx) => {
      // Row security shows the agency's own record, or one shared with it now (mutual aid).
      const r = await loadRecord(trx, request.params.ref);
      const shared = r.agency_id !== s.agencyId;
      if (shared)
        await request.authorize(
          'record.read',
          { type: 'record', id: r.cji_ref, agencyId: r.agency_id, sharedWithSubject: true },
          { asNotFound: true },
        );
      const out = await present(trx, r);
      const shares = await presentShares(trx, r, s.agencyId);
      // SEC-18: every read of CJI is recorded with what was shown; a read through a share says so.
      await request.audit(trx, {
        action: 'record.read',
        targetType: 'record',
        targetId: r.cji_ref,
        targetVersion: r.version,
        fields: RECORD_READ_FIELDS,
        ...(shared ? { reason: `read under a mutual-aid share from ${shares.ownerName}` } : {}),
      });
      return { ...out, ...shares };
    });
  });

  // ---- mutual aid (decision 2026-10-15; 0006) ------------------------------------------------

  /** The shares on a record as this agency may see them, and who owns the record. */
  async function presentShares(trx: Trx, r: RecordRow, viewerAgency: string) {
    const [owner, rows] = await Promise.all([
      trx.selectFrom('cjis.agency').select('name').where('id', '=', r.agency_id).executeTakeFirst(),
      trx
        .selectFrom('cjis.record_share as s')
        .innerJoin('cjis.agency as a', 'a.id', 's.to_agency_id')
        .leftJoin('cjis.person as g', 'g.id', 's.granted_by')
        .select([
          's.id',
          's.to_agency_id',
          'a.name as to_agency_name',
          's.platform_mission_reference',
          's.purpose',
          's.starts_at',
          's.ends_at',
          's.status',
          'g.display_name as granted_by',
          's.revoked_at',
          's.revoke_reason',
          's.ended_at',
          's.version',
        ])
        .where('s.record_id', '=', r.id)
        .orderBy('s.created_at', 'desc')
        .execute(),
    ]);
    const now = Date.now();
    const toDate = (v: Date | string) => (v instanceof Date ? v : new Date(v));
    return {
      ownAgency: r.agency_id === viewerAgency,
      ownerName: owner?.name ?? null,
      shares: rows
        // A helping agency sees its own share only (the policy shows it nothing else anyway).
        .filter((x) => r.agency_id === viewerAgency || x.to_agency_id === viewerAgency)
        .map((x) => ({
          id: x.id,
          toAgencyId: x.to_agency_id,
          toAgencyName: x.to_agency_name,
          platformMissionReference: x.platform_mission_reference,
          purpose: x.purpose,
          startsAt: toDate(x.starts_at).toISOString(),
          endsAt: toDate(x.ends_at).toISOString(),
          status: x.status === 'active' && toDate(x.ends_at).getTime() <= now ? 'ended' : x.status,
          grantedBy: x.granted_by,
          revokedAt: x.revoked_at ? toDate(x.revoked_at).toISOString() : null,
          revokeReason: x.revoke_reason,
          endedAt: x.ended_at ? toDate(x.ended_at).toISOString() : null,
          version: x.version,
        })),
    };
  }

  /** The agencies a record can be shared with: every active agency but one's own. */
  app.get('/agencies', async (request) => {
    const s = request.person();
    await request.authorize('record.share.read', { type: 'record_share', agencyId: s.agencyId });
    const rows = await request.tx((trx) =>
      trx
        .selectFrom('cjis.agency')
        .select(['id', 'name', 'agency_identifier'])
        .where('status', '=', 'active')
        .where('id', '<>', s.agencyId)
        .orderBy('name')
        .execute(),
    );
    return rows.map((a) => ({ id: a.id, name: a.name, identifier: a.agency_identifier }));
  });

  const MAX_SHARE_DAYS = 90;
  app.post(
    '/records/:ref/shares',
    {
      schema: {
        params: z.object({ ref }),
        body: z.object({
          toAgencyId: z.uuid(),
          endsAt: z.iso.datetime(),
          purpose: text(300),
          platformMissionReference: z.string().trim().min(1).max(40).optional(),
        }),
      },
      config: { requiresVersion: true },
    },
    async (request, reply) => {
      const s = request.person();
      // A role denial answers 403: the record is one the person can read. Another agency's
      // record is unknown to this agency's query (loadRecord below), so it answers 404.
      await request.authorize('record.share', {
        type: 'record',
        id: request.params.ref,
        agencyId: s.agencyId,
      });
      const expected = request.expectedVersion();
      const b = request.body;
      const endsAt = new Date(b.endsAt);
      const now = new Date();
      if (endsAt.getTime() <= now.getTime())
        throw new ApiError(400, 'validation_failed', 'The share must end in the future.');
      if (endsAt.getTime() > now.getTime() + MAX_SHARE_DAYS * 86_400_000)
        throw new ApiError(
          400,
          'validation_failed',
          `A share lasts at most ${MAX_SHARE_DAYS} days; grant it again when the mission goes on.`,
        );
      if (b.toAgencyId === s.agencyId)
        throw new ApiError(400, 'validation_failed', 'A record is not shared with its own agency.');
      const out = await request.tx(async (trx) => {
        const r = await loadRecord(trx, request.params.ref, s.agencyId);
        if (r.version !== expected) throw new ApiError(409, 'conflict', 'The record changed.');
        const to = await trx
          .selectFrom('cjis.agency')
          .select(['id', 'name'])
          .where('id', '=', b.toAgencyId)
          .where('status', '=', 'active')
          .executeTakeFirst();
        if (!to) throw new ApiError(400, 'validation_failed', 'Unknown or suspended agency.');
        const standing = await trx
          .selectFrom('cjis.record_share')
          .select('id')
          .where('record_id', '=', r.id)
          .where('to_agency_id', '=', to.id)
          .where('status', '=', 'active')
          .where('ends_at', '>', now)
          .executeTakeFirst();
        if (standing)
          throw new ApiError(409, 'already_shared', `${to.name} already has a standing share.`);
        const share = await trx
          .insertInto('cjis.record_share')
          .values({
            agency_id: r.agency_id,
            record_id: r.id,
            to_agency_id: to.id,
            platform_mission_reference: b.platformMissionReference ?? null,
            purpose: b.purpose,
            ends_at: endsAt,
            granted_by: s.personId,
          })
          .returning(['id', 'version'])
          .executeTakeFirstOrThrow();
        await touchRecord(trx, r, s.personId);
        await event(trx, request, r, 'shared', {
          shareId: share.id,
          toAgencyId: to.id,
          endsAt: endsAt.toISOString(),
        });
        await request.audit(trx, {
          action: 'record.share',
          targetType: 'record_share',
          targetId: share.id,
          targetVersion: share.version,
          fields: ['to_agency_id', 'ends_at', 'purpose'],
          reason: `shared with ${to.name} until ${endsAt.toISOString()}`,
        });
        const fresh = await loadRecord(trx, r.cji_ref, s.agencyId);
        return { ...(await present(trx, fresh)), ...(await presentShares(trx, fresh, s.agencyId)) };
      });
      return reply.code(201).send(out);
    },
  );

  app.post(
    '/records/:ref/shares/:id/revoke',
    { schema: { params: z.object({ ref, id: z.uuid() }) }, config: { requiresVersion: true } },
    async (request) => {
      const s = request.person();
      const decision = await request.authorize('record.share.revoke', {
        type: 'record_share',
        id: request.params.id,
        agencyId: s.agencyId,
      });
      const expected = request.expectedVersion();
      const reason = decision.confirmedReason;
      return request.tx(async (trx) => {
        const r = await loadRecord(trx, request.params.ref, s.agencyId);
        const share = await trx
          .selectFrom('cjis.record_share')
          .select(['id', 'status', 'version', 'to_agency_id'])
          .where('id', '=', request.params.id)
          .where('record_id', '=', r.id)
          .executeTakeFirst();
        if (!share) throw errors.notFound();
        if (share.status !== 'active')
          throw new ApiError(409, 'share_not_active', `The share is already ${share.status}.`);
        const updated = await trx
          .updateTable('cjis.record_share')
          .set({
            status: 'revoked',
            revoked_at: new Date(),
            revoked_by: s.personId,
            revoke_reason: reason,
          })
          .where('id', '=', share.id)
          .where('version', '=', expected)
          .returning(['id', 'version'])
          .executeTakeFirst();
        if (!updated) throw new ApiError(409, 'conflict', 'The share changed.');
        await touchRecord(trx, r, s.personId);
        await event(trx, request, r, 'share_revoked', {
          shareId: share.id,
          toAgencyId: share.to_agency_id,
        });
        await request.audit(trx, {
          action: 'record.share.revoke',
          targetType: 'record_share',
          targetId: share.id,
          targetVersion: updated.version,
          fields: ['status'],
          reason,
        });
        const fresh = await loadRecord(trx, r.cji_ref, s.agencyId);
        return { ...(await present(trx, fresh)), ...(await presentShares(trx, fresh, s.agencyId)) };
      });
    },
  );

  app.post(
    '/records',
    { schema: { body: createBody }, config: { idempotent: true } },
    async (request, reply) => {
      const s = request.person();
      await request.authorize('record.create', { type: 'record', agencyId: s.agencyId });
      const b = request.body;
      // The answer leaves only after the commit, so a client's next request sees the record.
      const out = await request.tx(async (trx) => {
        const existing = await trx
          .selectFrom('cjis.record')
          .select(['id', 'agency_id', 'cji_ref', 'state', 'version', 'disposition_by'])
          .where('cji_ref', '=', b.ref)
          .executeTakeFirst();
        if (existing) {
          // One record per reference and agency: a second create answers the first.
          await request.audit(trx, {
            action: 'record.read',
            targetType: 'record',
            targetId: existing.cji_ref,
            targetVersion: existing.version,
            fields: RECORD_READ_FIELDS,
            reason: 'create found the existing record',
          });
          return { status: 200, body: await present(trx, existing) };
        }
        const row = await trx
          .insertInto('cjis.record')
          .values({
            agency_id: s.agencyId,
            cji_ref: b.ref,
            platform_mission_reference: b.platformMissionReference ?? null,
            platform_county: b.platformCounty ?? null,
            origin: b.origin ?? null,
            classification: b.classification ?? null,
            offense_codes: b.offenseCodes ?? [],
            case_number_enc: await sealer.seal(s.agencyId, b.caseNumber),
            summary_enc: await sealer.seal(s.agencyId, b.summary),
            created_by: s.personId,
            updated_by: s.personId,
          })
          .returning(['id', 'agency_id', 'cji_ref', 'state', 'version', 'disposition_by'])
          .executeTakeFirstOrThrow();
        await event(trx, request, row, 'created', {
          fields: changedNames({ ...b, ref: undefined }),
        });
        await request.audit(trx, {
          action: 'record.create',
          targetType: 'record',
          targetId: row.cji_ref,
          targetVersion: row.version,
          fields: changedNames({ ...b, ref: undefined }),
        });
        return { status: 201, body: await present(trx, row) };
      });
      return reply.code(out.status).send(out.body);
    },
  );

  app.patch(
    '/records/:ref',
    {
      schema: { params: z.object({ ref }), body: z.object(recordFields) },
      config: { requiresVersion: true },
    },
    async (request) => {
      const s = request.person();
      await request.authorize(
        'record.update',
        { type: 'record', id: request.params.ref, agencyId: s.agencyId },
        { asNotFound: true },
      );
      const b = request.body;
      const expected = request.expectedVersion();
      return request.tx(async (trx) => {
        const r = await loadRecord(trx, request.params.ref, s.agencyId);
        assertOpen(r);
        const set: Record<string, unknown> = { updated_by: s.personId };
        if (b.origin !== undefined) set['origin'] = b.origin;
        if (b.classification !== undefined) set['classification'] = b.classification;
        if (b.offenseCodes !== undefined) set['offense_codes'] = b.offenseCodes;
        if (b.caseNumber !== undefined)
          set['case_number_enc'] = await sealer.seal(s.agencyId, b.caseNumber);
        if (b.summary !== undefined) set['summary_enc'] = await sealer.seal(s.agencyId, b.summary);
        const updated = await trx
          .updateTable('cjis.record')
          .set(set)
          .where('id', '=', r.id)
          .where('version', '=', expected)
          .returning(['id', 'agency_id', 'cji_ref', 'state', 'version', 'disposition_by'])
          .executeTakeFirst();
        if (!updated) throw errors.conflict(await present(trx, r));
        await event(trx, request, r, 'updated', { fields: changedNames(b) });
        await request.audit(trx, {
          action: 'record.update',
          targetType: 'record',
          targetId: r.cji_ref,
          targetVersion: updated.version,
          fields: changedNames(b),
        });
        return present(trx, updated);
      });
    },
  );

  /** People, weapons and body-camera references share one shape of route set. */
  type EntryKind = 'person' | 'weapon' | 'bodycam';
  const entryTable = {
    person: 'cjis.record_person',
    weapon: 'cjis.record_weapon',
    bodycam: 'cjis.record_bodycam',
  } as const;
  const entryPath = { person: 'people', weapon: 'weapons', bodycam: 'bodycams' } as const;

  async function entryValues(kind: EntryKind, agencyId: string, b: Record<string, unknown>) {
    const v: Record<string, unknown> = {};
    const has = (k: string) => b[k] !== undefined;
    const str = (k: string) => (b[k] as string | null | undefined) ?? null;
    if (kind === 'person') {
      if (has('role')) v['role'] = b['role'];
      if (has('name')) v['name_enc'] = await sealer.seal(agencyId, str('name'));
      if (has('birthDate')) v['birth_date_enc'] = await sealer.seal(agencyId, str('birthDate'));
      if (has('demographics'))
        v['demographics_enc'] = await sealer.sealJson(agencyId, b['demographics'] ?? null);
      for (const [k, col] of [
        ['contact', 'contact_enc'],
        ['address', 'address_enc'],
        ['identifiers', 'identifiers_enc'],
        ['notes', 'notes_enc'],
      ] as const) {
        if (has(k)) v[col] = await sealer.seal(agencyId, str(k));
      }
    } else if (kind === 'weapon') {
      if (has('kind')) v['kind'] = b['kind'];
      if (has('description'))
        v['description_enc'] = await sealer.seal(agencyId, str('description'));
      if (has('serialNumber')) v['serial_enc'] = await sealer.seal(agencyId, str('serialNumber'));
      if (has('disposition')) v['disposition'] = b['disposition'];
      if (has('personId')) v['person_id'] = b['personId'];
    } else {
      if (has('cameraLabel')) v['camera_label'] = b['cameraLabel'];
      if (has('officerPersonId')) v['officer_person_id'] = b['officerPersonId'];
      if (has('recordedFrom')) v['recorded_from'] = b['recordedFrom'];
      if (has('recordedTo')) v['recorded_to'] = b['recordedTo'];
      if (has('evidenceReference'))
        v['evidence_reference_enc'] = await sealer.seal(agencyId, str('evidenceReference'));
      if (has('notes')) v['notes_enc'] = await sealer.seal(agencyId, str('notes'));
    }
    return v;
  }

  async function checkLinks(trx: Trx, r: RecordRow, b: Record<string, unknown>) {
    const personId = b['personId'];
    if (typeof personId === 'string') {
      const p = await trx
        .selectFrom('cjis.record_person')
        .select('id')
        .where('id', '=', personId)
        .where('record_id', '=', r.id)
        .executeTakeFirst();
      if (!p)
        throw errors.validation([{ name: 'personId', message: 'not a person on this record' }]);
    }
    const officer = b['officerPersonId'];
    if (typeof officer === 'string') {
      const p = await trx
        .selectFrom('cjis.person')
        .select('id')
        .where('id', '=', officer)
        .executeTakeFirst();
      if (!p)
        throw errors.validation([
          { name: 'officerPersonId', message: 'not an account in this agency' },
        ]);
    }
  }

  const schemas = {
    person: { add: personBody, patch: personPatch },
    weapon: { add: weaponBody, patch: weaponPatch },
    bodycam: { add: bodycamBody, patch: bodycamPatch },
  } as const;

  for (const kind of ['person', 'weapon', 'bodycam'] as const) {
    const path = entryPath[kind];
    const table = entryTable[kind];

    app.post(
      `/records/:ref/${path}`,
      {
        schema: {
          params: z.object({ ref }),
          body: schemas[kind].add as z.ZodType<Record<string, unknown>>,
        },
        config: { idempotent: true, requiresVersion: true },
      },
      async (request, reply) => {
        const s = request.person();
        await request.authorize(
          'record.entry.write',
          { type: 'record', id: request.params.ref, agencyId: s.agencyId },
          { asNotFound: true },
        );
        const b = request.body;
        const expected = request.expectedVersion();
        const added = await request.tx(async (trx) => {
          const r = await loadRecord(trx, request.params.ref, s.agencyId);
          assertOpen(r);
          if (r.version !== expected) throw errors.conflict(await present(trx, r));
          await checkLinks(trx, r, b);
          const values = await entryValues(kind, s.agencyId, b);
          const row = await trx
            .insertInto(table)
            .values({
              ...values,
              agency_id: s.agencyId,
              record_id: r.id,
              created_by: s.personId,
              updated_by: s.personId,
            } as never)
            .returning('id')
            .executeTakeFirstOrThrow();
          await touchRecord(trx, r, s.personId);
          await event(trx, request, r, `${kind}_added`, {
            entry: row.id,
            fields: changedNames(b),
          });
          await request.audit(trx, {
            action: `record.${kind}.add`,
            targetType: `record_${kind}`,
            targetId: row.id,
            fields: changedNames(b).filter(
              (f) => recordedEntryFields[kind].includes(f) || f.endsWith('Id'),
            ),
            reason: `record ${r.cji_ref}`,
          });
          const updated = await loadRecord(trx, r.cji_ref);
          return { id: row.id, record: await present(trx, updated) };
        });
        return reply.code(201).send(added);
      },
    );

    app.patch(
      `/records/:ref/${path}/:id`,
      {
        schema: {
          params: z.object({ ref, id: z.uuid() }),
          body: schemas[kind].patch as z.ZodType<Record<string, unknown>>,
        },
        config: { requiresVersion: true },
      },
      async (request) => {
        const s = request.person();
        await request.authorize(
          'record.entry.write',
          { type: 'record', id: request.params.ref, agencyId: s.agencyId },
          { asNotFound: true },
        );
        const b = request.body;
        const expected = request.expectedVersion();
        return request.tx(async (trx) => {
          const r = await loadRecord(trx, request.params.ref, s.agencyId);
          assertOpen(r);
          await checkLinks(trx, r, b);
          const values = await entryValues(kind, s.agencyId, b);
          const updated = await trx
            .updateTable(table)
            .set({ ...values, updated_by: s.personId } as never)
            .where('id', '=', request.params.id)
            .where('record_id', '=', r.id)
            .where('status', '=', 'active')
            .where('version', '=', expected)
            .returning('id')
            .executeTakeFirst();
          if (!updated) {
            const exists = await trx
              .selectFrom(table)
              .select('id')
              .where('id', '=', request.params.id)
              .where('record_id', '=', r.id)
              .executeTakeFirst();
            if (!exists) throw errors.notFound();
            throw errors.conflict(await present(trx, r));
          }
          await touchRecord(trx, r, s.personId);
          await event(trx, request, r, `${kind}_updated`, {
            entry: request.params.id,
            fields: changedNames(b),
          });
          await request.audit(trx, {
            action: `record.${kind}.update`,
            targetType: `record_${kind}`,
            targetId: request.params.id,
            fields: changedNames(b),
            reason: `record ${r.cji_ref}`,
          });
          return present(trx, await loadRecord(trx, r.cji_ref));
        });
      },
    );

    app.post(
      `/records/:ref/${path}/:id/remove`,
      {
        schema: { params: z.object({ ref, id: z.uuid() }), body: removeBody },
        config: { requiresVersion: true },
      },
      async (request) => {
        const s = request.person();
        await request.authorize(
          'record.entry.write',
          { type: 'record', id: request.params.ref, agencyId: s.agencyId },
          { asNotFound: true },
        );
        const expected = request.expectedVersion();
        return request.tx(async (trx) => {
          const r = await loadRecord(trx, request.params.ref, s.agencyId);
          assertOpen(r);
          // BRD:FR-07.06: a removal keeps the row and its reason.
          const updated = await trx
            .updateTable(table)
            .set({
              status: 'removed',
              removed_reason: request.body.reason,
              removed_by: s.personId,
              removed_at: new Date(),
              updated_by: s.personId,
            })
            .where('id', '=', request.params.id)
            .where('record_id', '=', r.id)
            .where('status', '=', 'active')
            .where('version', '=', expected)
            .returning('id')
            .executeTakeFirst();
          if (!updated) throw errors.conflict(await present(trx, r));
          await touchRecord(trx, r, s.personId);
          await event(trx, request, r, `${kind}_removed`, { entry: request.params.id });
          await request.audit(trx, {
            action: `record.${kind}.remove`,
            targetType: `record_${kind}`,
            targetId: request.params.id,
            reason: request.body.reason,
          });
          return present(trx, await loadRecord(trx, r.cji_ref));
        });
      },
    );
  }

  app.post(
    '/records/:ref/narratives',
    {
      schema: {
        params: z.object({ ref }),
        body: z.object({ body: text(8000), amendsEventId: z.uuid().optional() }),
      },
      config: { idempotent: true },
    },
    async (request, reply) => {
      const s = request.person();
      await request.authorize(
        'record.narrative',
        { type: 'record', id: request.params.ref, agencyId: s.agencyId },
        { asNotFound: true },
      );
      // The narrative's role follows the author's enclave role (BRD:FR-07.01).
      const role = s.roles.includes('supervisor')
        ? 'supervisor'
        : s.roles.includes('officer')
          ? 'officer'
          : 'records';
      // Answered after the commit, so the version the client gets is the one it will find.
      const out = await request.tx(async (trx) => {
        const r = await loadRecord(trx, request.params.ref, s.agencyId);
        const amends = request.body.amendsEventId;
        if (amends) {
          const target = await trx
            .selectFrom('cjis.record_event')
            .select('kind')
            .where('id', '=', amends)
            .where('record_id', '=', r.id)
            .executeTakeFirst();
          if (!target || (target.kind !== 'narrative' && target.kind !== 'amendment'))
            throw errors.validation([
              { name: 'amendsEventId', message: 'only a narrative on this record can be amended' },
            ]);
        } else {
          assertOpen(r);
        }
        const ev = await event(
          trx,
          request,
          r,
          amends ? 'amendment' : 'narrative',
          {},
          {
            body_enc: await sealer.seal(s.agencyId, request.body.body),
            narrative_role: role,
            amends_event_id: amends ?? null,
          },
        );
        await touchRecord(trx, r, s.personId);
        await request.audit(trx, {
          action: amends ? 'record.amendment' : 'record.narrative',
          targetType: 'record',
          targetId: r.cji_ref,
          fields: ['narrative'],
          reason: amends ? `amends ${amends}` : null,
        });
        return { id: ev.id, record: await present(trx, await loadRecord(trx, r.cji_ref)) };
      });
      return reply.code(201).send(out);
    },
  );

  app.post(
    '/records/:ref/disposition',
    {
      schema: {
        params: z.object({ ref }),
        body: z.object({
          disposition: z.enum(DISPOSITIONS),
          note: text(2000).nullable().optional(),
        }),
      },
      config: { requiresVersion: true },
    },
    async (request) => {
      const s = request.person();
      const d = await request.authorize(
        'record.disposition',
        { type: 'record', id: request.params.ref, agencyId: s.agencyId },
        { asNotFound: true },
      );
      const expected = request.expectedVersion();
      return request.tx(async (trx) => {
        const r = await loadRecord(trx, request.params.ref, s.agencyId);
        assertOpen(r);
        const now = new Date();
        const updated = await trx
          .updateTable('cjis.record')
          .set({
            disposition: request.body.disposition,
            disposition_note_enc: await sealer.seal(s.agencyId, request.body.note),
            disposition_by: s.personId,
            disposition_at: now,
            reviewed_by: null,
            reviewed_at: null,
            state: 'closed',
            closed_at: now,
            updated_by: s.personId,
          })
          .where('id', '=', r.id)
          .where('version', '=', expected)
          .returning(['id', 'agency_id', 'cji_ref', 'state', 'version', 'disposition_by'])
          .executeTakeFirst();
        if (!updated) throw errors.conflict(await present(trx, r));
        await event(trx, request, r, 'disposition', { disposition: request.body.disposition });
        await request.audit(trx, {
          action: 'record.disposition',
          targetType: 'record',
          targetId: r.cji_ref,
          targetVersion: updated.version,
          fields: ['disposition', 'disposition_note'],
          reason: d.confirmedReason,
        });
        return present(trx, updated);
      });
    },
  );

  app.post(
    '/records/:ref/review',
    { schema: { params: z.object({ ref }) }, config: { requiresVersion: true } },
    async (request) => {
      const s = request.person();
      const recordedBy = await request.tx(async (trx) => {
        const r = await trx
          .selectFrom('cjis.record')
          .select('disposition_by')
          .where('cji_ref', '=', request.params.ref)
          .executeTakeFirst();
        return r?.disposition_by ?? null;
      });
      const d = await request.authorize(
        'record.review',
        { type: 'record', id: request.params.ref, agencyId: s.agencyId, recordedBy },
        { asNotFound: true },
      );
      const expected = request.expectedVersion();
      return request.tx(async (trx) => {
        const r = await loadRecord(trx, request.params.ref, s.agencyId);
        if (r.state !== 'closed')
          throw new ApiError(409, 'not_disposed', 'Record a disposition before the review.');
        const updated = await trx
          .updateTable('cjis.record')
          .set({ reviewed_by: s.personId, reviewed_at: new Date(), updated_by: s.personId })
          .where('id', '=', r.id)
          .where('version', '=', expected)
          .returning(['id', 'agency_id', 'cji_ref', 'state', 'version', 'disposition_by'])
          .executeTakeFirst();
        if (!updated) throw errors.conflict(await present(trx, r));
        await event(trx, request, r, 'reviewed');
        await request.audit(trx, {
          action: 'record.review',
          targetType: 'record',
          targetId: r.cji_ref,
          targetVersion: updated.version,
          reason: d.confirmedReason,
        });
        return present(trx, updated);
      });
    },
  );

  app.post(
    '/records/:ref/reopen',
    { schema: { params: z.object({ ref }) }, config: { requiresVersion: true } },
    async (request) => {
      const s = request.person();
      const d = await request.authorize(
        'record.reopen',
        { type: 'record', id: request.params.ref, agencyId: s.agencyId },
        { asNotFound: true },
      );
      const expected = request.expectedVersion();
      return request.tx(async (trx) => {
        const r = await loadRecord(trx, request.params.ref, s.agencyId);
        if (r.state !== 'closed') throw new ApiError(409, 'not_closed', 'This record is open.');
        const updated = await trx
          .updateTable('cjis.record')
          .set({
            state: 'open',
            closed_at: null,
            reviewed_by: null,
            reviewed_at: null,
            updated_by: s.personId,
          })
          .where('id', '=', r.id)
          .where('version', '=', expected)
          .returning(['id', 'agency_id', 'cji_ref', 'state', 'version', 'disposition_by'])
          .executeTakeFirst();
        if (!updated) throw errors.conflict(await present(trx, r));
        await event(trx, request, r, 'reopened');
        await request.audit(trx, {
          action: 'record.reopen',
          targetType: 'record',
          targetId: r.cji_ref,
          targetVersion: updated.version,
          reason: d.confirmedReason,
        });
        return present(trx, updated);
      });
    },
  );
};
