/**
 * Frontline role records from the field app (layer-4 task J; docs/04
 * FL:FR-01, FR-04, FR-05, FR-06, FR-08, FR-09, FR-14, FR-15, FR-19, FR-21,
 * FR-22, FR-24, FR-26, FR-28; CON-16, EQ-13, FLD-12, FLD-13, FLD-14,
 * ADM-05 G7, SEC-10, SEC-18):
 *
 * One small record per role, each behind its own actions (the role
 * templates grant them; default deny), each recorded once by the phone's id
 * so a resend is harmless, each listed only to the people who may read it
 * (their own records when the grant is limited to their own). Restricted
 * details are encrypted per tenant and decrypted only for readers of that
 * record kind, and every such read is audited: health notes (health roles
 * only), children's records (the minimum data, no photos; the guardian
 * pickup code is hashed and must match before a child is released), shelter
 * access needs, and right-of-entry signer names and signatures.
 *
 * A few records have a next step: a road reopens, a shelter guest or a child
 * checks out, an interpreter accepts and finishes, a right of entry gets its
 * release, stock moves. "No one home" on a canvass schedules a revisit
 * reminder for the canvasser (FR-28).
 */
import { randomInt } from 'node:crypto';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { sql, type Transaction } from 'kysely';
import { z } from 'zod';
import type { Database } from '@cg/db';
import { toUsng } from '@cg/field-core';
import { ApiError, errors } from '../errors.ts';
import { sha } from '../public/submit.ts';
import { iso, listQuery, stepKey, uuidParam } from './helpers.ts';
import { draftResupply } from './supply-requests.ts';

type Trx = Transaction<Database>;
/** The record tables are reached by name from the spec table; columns are checked by the database. */
type Loose = Transaction<Record<string, Record<string, unknown>>>;
type Row = Record<string, unknown> & { id: string; tenant_id: string };
const loose = (trx: Trx) => trx as unknown as Loose;

export interface FieldRecordDeps {
  /** Where encrypted signatures are kept (the same bucket as photos). */
  objects?: { client: import('@aws-sdk/client-s3').S3Client; bucket: string } | undefined;
}

const point = z.object({
  lat: z.number().min(-90).max(90),
  lon: z.number().min(-180).max(180),
  accuracyM: z.number().min(0).max(100_000).optional(),
});
const where = {
  parcelId: z.string().min(1).max(80).optional(),
  position: point.optional(),
  landmark: z.string().max(300).optional(),
};
const base = { clientUuid: z.uuid(), eventId: z.uuid().optional() };
const note = z.string().max(2000).optional();
/** No names or phone numbers in free text that is not restricted (SEC-10); the app says so too. */
const SIGNATURE_MAX = 60_000;

interface Ctx {
  request: FastifyRequest;
  trx: Trx;
  tenantId: string;
  accountId: string;
  personnelId: string | null;
  teamId: string | null;
  eventId: string | null;
  enc: (text: string) => Promise<Buffer>;
  dec: (blob: unknown) => Promise<string | null>;
  location: (b: {
    parcelId?: string | undefined;
    position?: z.infer<typeof point> | undefined;
    landmark?: string | undefined;
  }) => Promise<{ id: string | null; usng: string | null }>;
  putSignature: (id: string, svg: string) => Promise<string>;
}

interface Spec {
  table: string;
  write: string;
  read: string;
  /** The record needs an event (from the body or the person's open check-in). */
  needsEvent: boolean;
  body: z.ZodObject<z.ZodRawShape>;
  /** List filters this kind supports, query name → column. */
  filters: Record<string, string>;
  /** The column that names whose record it is, for grants limited to one's own (default created_by). */
  ownColumn?: string;
  orderColumn: string;
  /** Restricted details: reading them is audited (SEC-18). */
  restricted?: boolean;
  values(b: Record<string, unknown>, ctx: Ctx): Promise<Record<string, unknown>>;
  out(r: Row, ctx: Ctx): Promise<Record<string, unknown>>;
  /** Extra answer on create only (a code shown once). */
  created?: (b: Record<string, unknown>, ctx: Ctx, extra: Record<string, unknown>) => Promise<void>;
  after?: (b: Record<string, unknown>, r: Row, ctx: Ctx) => Promise<void>;
  summary?: (b: Record<string, unknown>) => string;
  /** An activity entry kind for the ICS 214 log (FLD-03). */
  activity?: 'note' | 'service' | 'hazard' | 'status';
  /** After the record is committed: a follow-up that may fail without undoing it. */
  afterCommit?: (
    b: Record<string, unknown>,
    out: Record<string, unknown>,
    request: FastifyRequest,
    instance: import('fastify').FastifyInstance,
  ) => Promise<FollowUp>;
}

/** What a follow-up may add to the answer: a named status, never fields copied from the request. */
interface FollowUp {
  residentMessage?: string;
}

/**
 * FL:FR-04: what a posted placard means, in the resident's language, plain and
 * short; never alert wording (docs/06), never the product name (ADM-03).
 */
export const PLACARD_TEXT: Record<string, { en: string; es: string }> = {
  inspected: {
    en: 'A building inspector checked your home and posted a green placard: it was inspected and you may use it. Reply to this message with any questions.',
    es: 'Un inspector revisó su vivienda y colocó un aviso verde: fue inspeccionada y puede usarla. Responda a este mensaje si tiene preguntas.',
  },
  restricted_use: {
    en: 'A building inspector posted a yellow placard on your home: you may go in only as the placard says, for example briefly to get belongings. Do not stay overnight. Reply to this message with any questions.',
    es: 'Un inspector colocó un aviso amarillo en su vivienda: puede entrar solo como indica el aviso, por ejemplo un momento para sacar sus pertenencias. No pase la noche allí. Responda a este mensaje si tiene preguntas.',
  },
  unsafe: {
    en: 'A building inspector posted a red placard on your home: it is not safe to enter. Please stay out. Reply to this message if you need help finding a place to stay.',
    es: 'Un inspector colocó un aviso rojo en su vivienda: no es seguro entrar. Por favor no entre. Responda a este mensaje si necesita ayuda para encontrar dónde quedarse.',
  },
};

const str = (v: unknown) => (typeof v === 'string' ? v : null);
const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));
const date = (v: unknown) => (v instanceof Date ? iso(v) : typeof v === 'string' ? v : null);
const common = (r: Row) => ({
  id: r.id,
  version: num(r['version']),
  createdAt: date(r['created_at']),
  createdBy: str(r['created_by']),
});

/** Codes read aloud and typed: no 0/O or 1/I (FR-26, FR-14). */
const CODE_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
function newCode(length = 6): string {
  let out = '';
  for (let i = 0; i < length; i += 1) out += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return out;
}
const normCode = (c: string) => c.toUpperCase().replace(/[^A-Z0-9]/g, '');

/** FEMA search mark quadrants (US&R): date/time and team top, hazards right, victims bottom. */
export function searchMarkCode(input: {
  at: Date;
  team: string | null;
  hazards: string[];
  occupantsFound: number;
  occupantsRemoved: number;
  victims: number;
  entry: string;
}): string {
  const d = input.at;
  const pad = (n: number) => String(n).padStart(2, '0');
  const when = `${pad(d.getUTCMonth() + 1)}/${pad(d.getUTCDate())} ${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}Z`;
  const left = input.team ?? 'TEAM';
  const right = input.hazards.length ? input.hazards.join(',').toUpperCase() : 'NONE';
  const bottom = `${input.victims}V ${input.occupantsFound}L/${input.occupantsRemoved}R`;
  return `[${when}] [${left}] [${right}] [${bottom}]${input.entry === 'exterior_only' ? ' EXT' : ''}`;
}

const SPECS: Record<string, Spec> = {
  // FL:FR-01: a search mark per structure, so no block is searched twice.
  search_mark: {
    table: 'cg.search_mark',
    write: 'search_mark.write',
    read: 'search_mark.read',
    needsEvent: true,
    orderColumn: 'searched_at',
    filters: { eventId: 'event_id', missionId: 'mission_id', parcelId: 'parcel_id' },
    body: z.object({
      ...base,
      ...where,
      missionId: z.uuid().optional(),
      entryType: z.enum(['primary', 'secondary', 'exterior_only']).default('primary'),
      occupantsFound: z.number().int().min(0).max(500).default(0),
      occupantsRemoved: z.number().int().min(0).max(500).default(0),
      victims: z.number().int().min(0).max(500).default(0),
      hazards: z
        .array(z.enum(['gas', 'electrical', 'water', 'structural', 'hazmat', 'animals', 'other']))
        .max(7)
        .default([]),
      note,
    }),
    async values(b, ctx) {
      const loc = await ctx.location(b as never);
      const team = ctx.teamId
        ? await ctx.trx
            .selectFrom('cg.team')
            .select(['callsign', 'name'])
            .where('id', '=', ctx.teamId)
            .executeTakeFirst()
        : undefined;
      return {
        event_id: ctx.eventId,
        mission_id: b['missionId'] ?? null,
        location_id: loc.id,
        parcel_id: b['parcelId'] ?? null,
        team_id: ctx.teamId,
        personnel_id: ctx.personnelId,
        entry_type: b['entryType'],
        occupants_found: b['occupantsFound'],
        occupants_removed: b['occupantsRemoved'],
        victims_count: b['victims'],
        hazards: b['hazards'],
        mark_code: searchMarkCode({
          at: new Date(),
          team: team?.callsign ?? team?.name ?? null,
          hazards: b['hazards'] as string[],
          occupantsFound: b['occupantsFound'] as number,
          occupantsRemoved: b['occupantsRemoved'] as number,
          victims: b['victims'] as number,
          entry: b['entryType'] as string,
        }),
        note: b['note'] ?? null,
        usng: loc.usng,
      };
    },
    async out(r) {
      return {
        ...common(r),
        eventId: str(r['event_id']),
        missionId: str(r['mission_id']),
        parcelId: str(r['parcel_id']),
        teamId: str(r['team_id']),
        entryType: str(r['entry_type']),
        occupantsFound: num(r['occupants_found']),
        occupantsRemoved: num(r['occupants_removed']),
        victims: num(r['victims_count']),
        hazards: r['hazards'],
        markCode: str(r['mark_code']),
        usng: str(r['usng']),
        note: str(r['note']),
        searchedAt: date(r['searched_at']),
      };
    },
    summary: (b) => `Search mark ${String(b['parcelId'] ?? '')}`.trim(),
    activity: 'note',
  },

  // FL:FR-04: a posted placard. The resident's explanation in their language is sent from the console (task K).
  placard: {
    table: 'cg.placard',
    write: 'placard.write',
    read: 'placard.read',
    needsEvent: true,
    orderColumn: 'posted_at',
    filters: { eventId: 'event_id', parcelId: 'parcel_id', reportId: 'report_id' },
    body: z.object({
      ...base,
      ...where,
      reportId: z.uuid().optional(),
      kind: z.enum(['inspected', 'restricted_use', 'unsafe']),
      note,
    }),
    async values(b, ctx) {
      const loc = await ctx.location(b as never);
      return {
        event_id: ctx.eventId,
        location_id: loc.id,
        parcel_id: b['parcelId'] ?? null,
        report_id: b['reportId'] ?? null,
        kind: b['kind'],
        inspector_personnel_id: ctx.personnelId,
        note: b['note'] ?? null,
      };
    },
    async out(r) {
      return {
        ...common(r),
        eventId: str(r['event_id']),
        parcelId: str(r['parcel_id']),
        reportId: str(r['report_id']),
        kind: str(r['kind']),
        note: str(r['note']),
        postedAt: date(r['posted_at']),
      };
    },
    summary: (b) => `Placard ${String(b['kind'])} ${String(b['parcelId'] ?? '')}`.trim(),
    activity: 'note',
    // FL:FR-04: the resident hears what the placard means, in their language, if they can be reached.
    async afterCommit(b, _out, request, instance) {
      if (!b['reportId']) return {};
      const report = await request.tx((trx) =>
        trx
          .selectFrom('cg.report')
          .select('original_lang')
          .where('id', '=', b['reportId'] as string)
          .executeTakeFirst(),
      );
      const lang = report?.original_lang?.startsWith('es') ? 'es' : 'en';
      const text = PLACARD_TEXT[String(b['kind'])]?.[lang];
      if (!text) return {};
      const res = await instance.inject({
        method: 'POST',
        url: `/api/v1/reports/${String(b['reportId'])}/messages`,
        headers: {
          authorization: String(request.headers['authorization'] ?? ''),
          'idempotency-key': stepKey(String(b['clientUuid']), 'placard-message'),
        },
        payload: { text },
      });
      const body = res.body
        ? (JSON.parse(res.body) as { queued?: boolean; reason?: string | null })
        : {};
      return {
        residentMessage:
          res.statusCode < 300 && body.queued
            ? 'queued'
            : res.statusCode === 403
              ? 'not_allowed'
              : (body.reason ?? 'not_sent'),
      };
    },
  },

  // FL:FR-05: road status in one tap.
  road_status: {
    table: 'cg.road_status',
    write: 'road_status.write',
    read: 'road_status.read',
    needsEvent: true,
    orderColumn: 'reported_at',
    filters: { eventId: 'event_id', status: 'status' },
    body: z.object({
      ...base,
      name: z.string().min(1).max(200),
      status: z.enum(['open', 'closed', 'one_lane', 'impassable', 'cleared']),
      reason: z.string().max(300).optional(),
      position: point.optional(),
    }),
    async values(b, ctx) {
      const p = b['position'] as z.infer<typeof point> | undefined;
      return {
        event_id: ctx.eventId,
        name: b['name'],
        status: b['status'],
        reason: b['reason'] ?? null,
        geom: p ? sql`ST_SetSRID(ST_MakePoint(${p.lon}, ${p.lat}), 4326)` : null,
        reported_by: ctx.accountId,
        reported_personnel_id: ctx.personnelId,
      };
    },
    async out(r) {
      return {
        ...common(r),
        eventId: str(r['event_id']),
        name: str(r['name']),
        status: str(r['status']),
        reason: str(r['reason']),
        reportedAt: date(r['reported_at']),
        clearedAt: date(r['cleared_at']),
      };
    },
    summary: (b) => `Road ${String(b['name'])}: ${String(b['status']).replace(/_/g, ' ')}`,
    activity: 'status',
  },

  // FL:FR-05: a debris load ticket for FEMA Public Assistance; cubic yards from capacity and load.
  debris_ticket: {
    table: 'cg.debris_ticket',
    write: 'debris_ticket.write',
    read: 'debris_ticket.read',
    needsEvent: true,
    orderColumn: 'loaded_at',
    filters: { eventId: 'event_id', debrisType: 'debris_type' },
    body: z.object({
      ...base,
      ...where,
      ticketNumber: z.string().min(1).max(40),
      debrisType: z.enum([
        'vegetative',
        'construction',
        'mixed',
        'white_goods',
        'hazardous',
        'electronic',
        'other',
      ]),
      truckId: z.string().max(40).optional(),
      truckCapacityCy: z.number().min(0).max(500).optional(),
      loadPercent: z.number().int().min(0).max(100).optional(),
      disposalSite: z.string().max(200).optional(),
    }),
    async values(b, ctx) {
      const loc = b['position'] || b['parcelId'] ? await ctx.location(b as never) : { id: null };
      const cap = b['truckCapacityCy'] as number | undefined;
      const pct = b['loadPercent'] as number | undefined;
      return {
        event_id: ctx.eventId,
        ticket_number: b['ticketNumber'],
        load_location_id: loc.id,
        disposal_site: b['disposalSite'] ?? null,
        truck_id: b['truckId'] ?? null,
        truck_capacity_cy: cap ?? null,
        load_percent: pct ?? null,
        cubic_yards: cap !== undefined && pct !== undefined ? Math.round(cap * pct) / 100 : null,
        debris_type: b['debrisType'],
        monitor_personnel_id: ctx.personnelId,
      };
    },
    async out(r) {
      return {
        ...common(r),
        eventId: str(r['event_id']),
        ticketNumber: str(r['ticket_number']),
        debrisType: str(r['debris_type']),
        truckId: str(r['truck_id']),
        truckCapacityCy: num(r['truck_capacity_cy']),
        loadPercent: num(r['load_percent']),
        cubicYards: num(r['cubic_yards']),
        disposalSite: str(r['disposal_site']),
        loadedAt: date(r['loaded_at']),
      };
    },
    summary: (b) => `Debris ticket ${String(b['ticketNumber'])}`,
    activity: 'service',
  },

  // FL:FR-06: a site inspection; illness is a count only, never a person (EQ-13).
  inspection: {
    table: 'cg.inspection',
    write: 'inspection.write',
    read: 'inspection.read',
    needsEvent: true,
    orderColumn: 'inspected_at',
    filters: { eventId: 'event_id', siteId: 'site_id', result: 'result' },
    body: z.object({
      ...base,
      siteId: z.uuid().optional(),
      kind: z.enum(['shelter', 'feeding_site', 'pod', 'warehouse', 'other']),
      checklist: z.record(z.string().max(60), z.enum(['yes', 'no', 'na'])).default({}),
      result: z.enum(['pass', 'corrective', 'fail']),
      illnessCount: z.number().int().min(0).max(10_000).optional(),
      note,
    }),
    async values(b, ctx) {
      return {
        event_id: ctx.eventId,
        site_id: b['siteId'] ?? null,
        kind: b['kind'],
        checklist: JSON.stringify(b['checklist']),
        result: b['result'],
        illness_count: b['illnessCount'] ?? null,
        inspector_personnel_id: ctx.personnelId,
        note: b['note'] ?? null,
      };
    },
    async out(r) {
      return {
        ...common(r),
        eventId: str(r['event_id']),
        siteId: str(r['site_id']),
        kind: str(r['kind']),
        checklist: r['checklist'],
        result: str(r['result']),
        illnessCount: num(r['illness_count']),
        note: str(r['note']),
        inspectedAt: date(r['inspected_at']),
      };
    },
    summary: (b) => `Inspection (${String(b['kind']).replace(/_/g, ' ')}): ${String(b['result'])}`,
    activity: 'note',
  },

  // FL:FR-08: pet intake, linked to the owner's reference code, never the owner's name.
  pet_intake: {
    table: 'cg.pet_intake',
    write: 'pet_intake.write',
    read: 'pet_intake.read',
    needsEvent: true,
    orderColumn: 'intake_at',
    filters: { eventId: 'event_id', siteId: 'site_id', status: 'status' },
    body: z.object({
      ...base,
      siteId: z.uuid().optional(),
      ownerReferenceCode: z.string().max(20).optional(),
      species: z.string().min(1).max(40),
      description: z.string().max(300).optional(),
      status: z
        .enum(['sheltered', 'reunited', 'transferred', 'lost_report', 'found_report', 'deceased'])
        .default('sheltered'),
    }),
    async values(b, ctx) {
      return {
        event_id: ctx.eventId,
        site_id: b['siteId'] ?? null,
        owner_reference_code: b['ownerReferenceCode']
          ? normCode(b['ownerReferenceCode'] as string)
          : null,
        species: b['species'],
        description: b['description'] ?? null,
        status: b['status'],
      };
    },
    async out(r) {
      return {
        ...common(r),
        eventId: str(r['event_id']),
        siteId: str(r['site_id']),
        ownerReferenceCode: str(r['owner_reference_code']),
        species: str(r['species']),
        description: str(r['description']),
        status: str(r['status']),
        intakeAt: date(r['intake_at']),
        releasedAt: date(r['released_at']),
        /** FL:FR-08: the lost report or found animal a person confirmed as the same pet. */
        matchedWith: str(r['matched_with']),
      };
    },
    summary: (b) => `Pet intake: ${String(b['species'])}`,
    activity: 'service',
  },

  // FL:FR-09: facility walk-through before and after use.
  site_walkthrough: {
    table: 'cg.site_walkthrough',
    write: 'walkthrough.write',
    read: 'walkthrough.read',
    needsEvent: false,
    orderColumn: 'walked_at',
    filters: { siteId: 'site_id', phase: 'phase' },
    body: z.object({
      clientUuid: z.uuid(),
      siteId: z.uuid(),
      phase: z.enum(['before', 'after']),
      keyHolders: z.string().max(300).optional(),
      issues: z.string().max(2000).optional(),
    }),
    async values(b, ctx) {
      return {
        site_id: b['siteId'],
        phase: b['phase'],
        key_holders: b['keyHolders'] ?? null,
        issues: b['issues'] ?? null,
        personnel_id: ctx.personnelId,
      };
    },
    async out(r) {
      return {
        ...common(r),
        siteId: str(r['site_id']),
        phase: str(r['phase']),
        keyHolders: str(r['key_holders']),
        issues: str(r['issues']),
        walkedAt: date(r['walked_at']),
      };
    },
  },

  // FL:FR-19: right of entry signed on the phone; the signer's name and signature are restricted.
  right_of_entry: {
    table: 'cg.right_of_entry',
    write: 'right_of_entry.write',
    read: 'right_of_entry.read',
    needsEvent: true,
    restricted: true,
    orderColumn: 'signed_at',
    filters: { eventId: 'event_id', missionId: 'mission_id', needId: 'need_id' },
    body: z.object({
      ...base,
      ...where,
      missionId: z.uuid().optional(),
      needId: z.uuid().optional(),
      reportId: z.uuid().optional(),
      signerRole: z.enum(['owner', 'landlord', 'tenant', 'agent']),
      signerName: z.string().min(1).max(200),
      scope: z.string().min(3).max(1000),
      landlordConsent: z.boolean().default(false),
      /** The drawn signature as SVG path data, or `typed:<name>` when signed by typing (WCAG 2.1.1); encrypted at rest. */
      signatureSvg: z.string().min(8).max(SIGNATURE_MAX),
    }),
    async values(b, ctx) {
      // A renter can let a crew in, but work on the structure needs the owner's consent (FR-19).
      if (b['signerRole'] === 'tenant' && !b['landlordConsent'])
        throw errors.validation([
          { name: 'landlordConsent', message: 'a renter’s work needs the landlord’s consent' },
        ]);
      const loc = await ctx.location(b as never);
      return {
        event_id: ctx.eventId,
        mission_id: b['missionId'] ?? null,
        need_id: b['needId'] ?? null,
        report_id: b['reportId'] ?? null,
        location_id: loc.id,
        signer_role: b['signerRole'],
        signer_name_enc: await ctx.enc(b['signerName'] as string),
        scope: b['scope'],
        landlord_consent: b['landlordConsent'],
        witness_personnel_id: ctx.personnelId,
      };
    },
    async after(b, r, ctx) {
      const key = await ctx.putSignature(r.id, b['signatureSvg'] as string);
      await loose(ctx.trx)
        .updateTable('cg.right_of_entry')
        .set({ signature_key: key })
        .where('id', '=', r.id)
        .execute();
      r['signature_key'] = key;
    },
    async out(r, ctx) {
      return {
        ...common(r),
        eventId: str(r['event_id']),
        missionId: str(r['mission_id']),
        needId: str(r['need_id']),
        signerRole: str(r['signer_role']),
        signerName: await ctx.dec(r['signer_name_enc']),
        scope: str(r['scope']),
        landlordConsent: r['landlord_consent'] === true,
        signed: !!r['signature_key'],
        signedAt: date(r['signed_at']),
        releaseSignedAt: date(r['release_signed_at']),
      };
    },
    summary: (b) => `Right of entry signed (${String(b['signerRole'])})`,
    activity: 'note',
  },

  // FL:FR-24: a request for an interpreter, by language.
  interpreter_request: {
    table: 'cg.interpreter_request',
    write: 'interpreter.request',
    read: 'interpreter.read',
    needsEvent: true,
    orderColumn: 'requested_at',
    filters: { eventId: 'event_id', state: 'state', language: 'language', siteId: 'site_id' },
    body: z.object({
      ...base,
      language: z.string().min(2).max(40),
      mode: z.enum(['in_person', 'phone', 'video']).default('phone'),
      siteId: z.uuid().optional(),
      missionId: z.uuid().optional(),
      note,
    }),
    async values(b, ctx) {
      return {
        event_id: ctx.eventId,
        language: (b['language'] as string).toLowerCase(),
        mode: b['mode'],
        site_id: b['siteId'] ?? null,
        mission_id: b['missionId'] ?? null,
        requested_by: ctx.accountId,
        requested_personnel_id: ctx.personnelId,
        note: b['note'] ?? null,
      };
    },
    async out(r) {
      return {
        ...common(r),
        eventId: str(r['event_id']),
        language: str(r['language']),
        mode: str(r['mode']),
        siteId: str(r['site_id']),
        missionId: str(r['mission_id']),
        state: str(r['state']),
        interpreterPersonnelId: str(r['interpreter_personnel_id']),
        requestedAt: date(r['requested_at']),
        acceptedAt: date(r['accepted_at']),
        doneAt: date(r['done_at']),
        minutes: num(r['minutes']),
        note: str(r['note']),
      };
    },
    summary: (b) => `Interpreter requested: ${String(b['language'])}`,
    activity: 'note',
  },

  // FL:FR-26: a child checked in with the minimum data and a guardian pickup code; no photos.
  child_check_in: {
    table: 'cg.child_check_in',
    write: 'child_check_in.write',
    read: 'child_check_in.read',
    needsEvent: false,
    restricted: true,
    orderColumn: 'checked_in_at',
    filters: { siteId: 'site_id' },
    body: z.object({
      clientUuid: z.uuid(),
      siteId: z.uuid(),
      childName: z.string().min(1).max(120),
      ageBand: z.enum(['0-2', '3-5', '6-9', '10-13', '14-17']),
      guardianName: z.string().min(1).max(120),
      guardianPhone: z.string().max(30).optional(),
      needs: z.string().max(500).optional(),
    }),
    async values(b, ctx) {
      return {
        site_id: b['siteId'],
        child_enc: await ctx.enc(b['childName'] as string),
        age_band: b['ageBand'],
        guardian_enc: await ctx.enc(
          JSON.stringify({ name: b['guardianName'], phone: b['guardianPhone'] ?? null }),
        ),
        // Replaced on insert by created(); a placeholder satisfies not-null until then.
        pickup_code_hash: Buffer.alloc(32),
        needs_enc: b['needs'] ? await ctx.enc(b['needs'] as string) : null,
        staff_personnel_id: ctx.personnelId,
      };
    },
    async out(r, ctx) {
      const guardian = await ctx.dec(r['guardian_enc']);
      return {
        ...common(r),
        siteId: str(r['site_id']),
        childName: await ctx.dec(r['child_enc']),
        ageBand: str(r['age_band']),
        guardian: guardian ? (JSON.parse(guardian) as unknown) : null,
        needs: await ctx.dec(r['needs_enc']),
        checkedInAt: date(r['checked_in_at']),
        checkedOutAt: date(r['checked_out_at']),
        checkedOutTo: await ctx.dec(r['checked_out_to_enc']),
      };
    },
    summary: () => 'Child checked in',
    activity: 'service',
  },

  // FL:FR-28: a canvass visit; "no one home" schedules a revisit.
  canvass_visit: {
    table: 'cg.canvass_visit',
    write: 'canvass_visit.write',
    read: 'canvass_visit.read',
    needsEvent: true,
    orderColumn: 'visited_at',
    filters: {
      eventId: 'event_id',
      missionId: 'mission_id',
      parcelId: 'parcel_id',
      outcome: 'outcome',
    },
    body: z.object({
      ...base,
      ...where,
      missionId: z.uuid().optional(),
      outcome: z.enum([
        'spoke_with_resident',
        'assisted_report',
        'no_one_home',
        'refused',
        'vacant',
        'unsafe',
        'referred',
      ]),
      reportId: z.uuid().optional(),
      doorHangerLeft: z.boolean().default(false),
      language: z.string().max(20).optional(),
      revisitAt: z.iso.datetime().optional(),
      note,
    }),
    async values(b, ctx) {
      const loc = await ctx.location(b as never);
      const revisit =
        b['outcome'] === 'no_one_home'
          ? new Date((b['revisitAt'] as string | undefined) ?? Date.now() + 24 * 3_600_000)
          : null;
      return {
        event_id: ctx.eventId,
        mission_id: b['missionId'] ?? null,
        location_id: loc.id,
        parcel_id: b['parcelId'] ?? null,
        team_id: ctx.teamId,
        personnel_id: ctx.personnelId,
        outcome: b['outcome'],
        report_id: b['reportId'] ?? null,
        door_hanger_left: b['doorHangerLeft'],
        language: b['language'] ?? null,
        revisit_at: revisit,
        note: b['note'] ?? null,
      };
    },
    async after(b, r, ctx) {
      if (b['outcome'] !== 'no_one_home') return;
      const reminder = await ctx.trx
        .insertInto('cg.reminder')
        .values({
          tenant_id: ctx.tenantId,
          event_id: ctx.eventId,
          kind: 'revisit',
          title: `Revisit ${String(b['parcelId'] ?? b['landmark'] ?? 'the property')}: no one home`,
          note: null,
          owner_account_id: ctx.accountId,
          owner_team_id: ctx.teamId,
          mission_id: (b['missionId'] as string | undefined) ?? null,
          subject_kind: 'canvass_visit',
          subject_id: r.id,
          due_at: r['revisit_at'] as Date,
          created_by: ctx.accountId,
          updated_by: ctx.accountId,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      await loose(ctx.trx)
        .updateTable('cg.canvass_visit')
        .set({ reminder_id: reminder.id })
        .where('id', '=', r.id)
        .execute();
      r['reminder_id'] = reminder.id;
    },
    async out(r) {
      return {
        ...common(r),
        eventId: str(r['event_id']),
        missionId: str(r['mission_id']),
        parcelId: str(r['parcel_id']),
        outcome: str(r['outcome']),
        reportId: str(r['report_id']),
        doorHangerLeft: r['door_hanger_left'] === true,
        language: str(r['language']),
        revisitAt: date(r['revisit_at']),
        reminderId: str(r['reminder_id']),
        note: str(r['note']),
        visitedAt: date(r['visited_at']),
      };
    },
    summary: (b) =>
      `Canvass ${String(b['parcelId'] ?? '')}: ${String(b['outcome']).replace(/_/g, ' ')}`,
    activity: 'note',
  },

  // CON-16, FL:FR-14: shelter registration at the door; access needs restricted (ADM-05 G7).
  shelter_stay: {
    table: 'cg.shelter_stay',
    write: 'shelter_stay.write',
    read: 'shelter_stay.read',
    needsEvent: true,
    restricted: true,
    orderColumn: 'checked_in_at',
    filters: { eventId: 'event_id', siteId: 'site_id' },
    body: z.object({
      ...base,
      siteId: z.uuid(),
      householdName: z.string().max(200).optional(),
      householdSize: z.number().int().min(1).max(30),
      adults: z.number().int().min(0).max(30),
      children: z.number().int().min(0).max(30),
      cots: z.array(z.string().min(1).max(20)).max(30).default([]),
      dietaryNeeds: z.string().max(300).optional(),
      accessNeeds: z.string().max(500).optional(),
      pets: z.number().int().min(0).max(20).default(0),
      language: z.string().max(20).optional(),
    }),
    async values(b, ctx) {
      if ((b['adults'] as number) + (b['children'] as number) !== b['householdSize'])
        throw errors.validation([
          { name: 'householdSize', message: 'adults and children should add up to the household' },
        ]);
      return {
        site_id: b['siteId'],
        event_id: ctx.eventId,
        household_enc: b['householdName'] ? await ctx.enc(b['householdName'] as string) : null,
        household_size: b['householdSize'],
        adults: b['adults'],
        children: b['children'],
        cots: b['cots'],
        dietary_needs: b['dietaryNeeds'] ?? null,
        access_needs_enc: b['accessNeeds'] ? await ctx.enc(b['accessNeeds'] as string) : null,
        pets: b['pets'],
        language: b['language'] ?? null,
        registered_by: ctx.accountId,
      };
    },
    async out(r, ctx) {
      return {
        ...common(r),
        siteId: str(r['site_id']),
        eventId: str(r['event_id']),
        householdName: await ctx.dec(r['household_enc']),
        householdSize: num(r['household_size']),
        adults: num(r['adults']),
        children: num(r['children']),
        cots: r['cots'],
        dietaryNeeds: str(r['dietary_needs']),
        accessNeeds: await ctx.dec(r['access_needs_enc']),
        pets: num(r['pets']),
        language: str(r['language']),
        checkedInAt: date(r['checked_in_at']),
        checkedOutAt: date(r['checked_out_at']),
        checkedOutReason: str(r['checked_out_reason']),
      };
    },
    summary: (b) => `Shelter check-in: household of ${String(b['householdSize'])}`,
    activity: 'service',
  },

  // FL:FR-14: the quiet incident log (append-only, encrypted).
  shelter_incident: {
    table: 'cg.shelter_incident',
    write: 'shelter_incident.write',
    read: 'shelter_incident.read',
    needsEvent: false,
    restricted: true,
    ownColumn: 'reported_by',
    orderColumn: 'occurred_at',
    filters: { siteId: 'site_id', kind: 'kind' },
    body: z.object({
      clientUuid: z.uuid(),
      siteId: z.uuid(),
      kind: z.enum(['medical', 'behavioral', 'safety', 'security', 'facility', 'other']),
      summary: z.string().min(3).max(2000),
    }),
    async values(b, ctx) {
      return {
        site_id: b['siteId'],
        kind: b['kind'],
        summary_enc: await ctx.enc(b['summary'] as string),
        reported_by: ctx.accountId,
      };
    },
    async out(r, ctx) {
      return {
        id: r.id,
        siteId: str(r['site_id']),
        kind: str(r['kind']),
        summary: await ctx.dec(r['summary_enc']),
        occurredAt: date(r['occurred_at']),
        reportedBy: str(r['reported_by']),
      };
    },
  },

  // FL:FR-15: health notes and requests; health roles only, every view audited (SEC-18).
  health_note: {
    table: 'cg.health_note',
    write: 'health_note.write',
    read: 'health_note.read',
    needsEvent: false,
    restricted: true,
    orderColumn: 'created_at',
    filters: {
      siteId: 'site_id',
      shelterStayId: 'shelter_stay_id',
      requestStatus: 'request_status',
    },
    body: z.object({
      clientUuid: z.uuid(),
      siteId: z.uuid().optional(),
      shelterStayId: z.uuid().optional(),
      kind: z.enum([
        'medication_request',
        'equipment_replacement',
        'assessment',
        'follow_up',
        'other',
      ]),
      note: z.string().min(3).max(4000),
      requestStatus: z.enum(['open', 'ordered', 'delivered', 'closed']).optional(),
    }),
    async values(b, ctx) {
      const request = b['kind'] === 'medication_request' || b['kind'] === 'equipment_replacement';
      return {
        site_id: b['siteId'] ?? null,
        shelter_stay_id: b['shelterStayId'] ?? null,
        kind: b['kind'],
        note_enc: await ctx.enc(b['note'] as string),
        request_status: b['requestStatus'] ?? (request ? 'open' : null),
        author_personnel_id: ctx.personnelId,
      };
    },
    async out(r, ctx) {
      return {
        ...common(r),
        siteId: str(r['site_id']),
        shelterStayId: str(r['shelter_stay_id']),
        kind: str(r['kind']),
        note: await ctx.dec(r['note_enc']),
        requestStatus: str(r['request_status']),
      };
    },
  },

  // FL:FR-17: a canteen crew arrives at a stop on its route; the check-out (below) names
  // this record by the phone's id, so both work without signal.
  canteen_stop: {
    table: 'cg.canteen_stop',
    write: 'canteen_stop.write',
    read: 'canteen_stop.read',
    needsEvent: true,
    orderColumn: 'arrived_at',
    filters: { eventId: 'event_id', missionId: 'mission_id' },
    body: z.object({
      ...base,
      missionId: z.uuid().optional(),
      /** A public place: a park, a church lot, a street corner; never a household. */
      stopName: z.string().min(1).max(120),
      position: point.optional(),
      arrivedAt: z.iso.datetime().optional(),
    }),
    async values(b, ctx) {
      const p = b['position'] as z.infer<typeof point> | undefined;
      return {
        event_id: ctx.eventId,
        mission_id: b['missionId'] ?? null,
        stop_name: b['stopName'],
        geom: p ? sql`ST_SetSRID(ST_MakePoint(${p.lon}, ${p.lat}), 4326)` : null,
        ...(b['arrivedAt'] ? { arrived_at: new Date(b['arrivedAt'] as string) } : {}),
        reported_by: ctx.accountId,
        reported_personnel_id: ctx.personnelId,
      };
    },
    async out(r) {
      return {
        ...common(r),
        eventId: str(r['event_id']),
        missionId: str(r['mission_id']),
        stopName: str(r['stop_name']),
        arrivedAt: date(r['arrived_at']),
        departedAt: date(r['departed_at']),
        mealsServed: num(r['meals_served']),
        suppliesLeft: str(r['supplies_left']),
        allergenNote: str(r['allergen_note']),
      };
    },
    summary: (b) => `Canteen stop: ${String(b['stopName'])}`,
    activity: 'status',
  },

  // FL:FR-19: equipment that ran on a work order and its hours that day (FEMA PA equipment
  // hours); people's hours come from check-in.
  equipment_use: {
    table: 'cg.equipment_use',
    write: 'equipment_use.write',
    read: 'equipment_use.read',
    // The event is the work order's.
    needsEvent: false,
    orderColumn: 'used_on',
    filters: { eventId: 'event_id', missionId: 'mission_id', kind: 'equipment' },
    body: z.object({
      ...base,
      missionId: z.uuid(),
      equipment: z.enum([
        'chainsaw',
        'pump',
        'generator',
        'skid_steer',
        'dump_truck',
        'chipper',
        'pressure_washer',
        'dehumidifier',
        'other',
      ]),
      equipmentNote: z.string().max(120).optional(),
      hours: z.number().gt(0).max(24),
      usedOn: z.iso.date().optional(),
    }),
    async values(b, ctx) {
      const mission = await ctx.trx
        .selectFrom('cg.mission')
        .select(['id', 'event_id'])
        .where('id', '=', b['missionId'] as string)
        .executeTakeFirst();
      if (!mission) throw errors.validation([{ name: 'missionId', message: 'unknown work order' }]);
      if (b['equipment'] === 'other' && !b['equipmentNote'])
        throw errors.validation([{ name: 'equipmentNote', message: 'say what the equipment was' }]);
      return {
        event_id: mission.event_id,
        mission_id: mission.id,
        equipment: b['equipment'],
        equipment_note: b['equipmentNote'] ?? null,
        hours: String(b['hours']),
        ...(b['usedOn'] ? { used_on: b['usedOn'] } : {}),
        reported_by: ctx.accountId,
        reported_personnel_id: ctx.personnelId,
      };
    },
    async out(r) {
      return {
        ...common(r),
        eventId: str(r['event_id']),
        missionId: str(r['mission_id']),
        equipment: str(r['equipment']),
        equipmentNote: str(r['equipment_note']),
        hours: num(r['hours']),
        usedOn: r['used_on'] instanceof Date ? iso(r['used_on'])!.slice(0, 10) : str(r['used_on']),
      };
    },
    summary: (b) =>
      `Equipment: ${String(b['equipment']).replace(/_/g, ' ')}, ${String(b['hours'])} h`,
    activity: 'service',
  },

  // FLD-11: the quick report that is not a hazard: what a worker saw at a site, or a
  // resource they came across. An observation for dispatch, never the site's status of
  // record (only the site's operators confirm that, `site.confirm`).
  field_report: {
    table: 'cg.field_report',
    write: 'field_report.write',
    read: 'field_report.read',
    needsEvent: true,
    orderColumn: 'reported_at',
    filters: { eventId: 'event_id', siteId: 'site_id', kind: 'category' },
    body: z.object({
      ...base,
      category: z.enum(['site_status', 'resource_seen']),
      siteId: z.uuid().optional(),
      siteStatus: z.enum(['open', 'limited', 'full', 'closed', 'damaged']).optional(),
      resourceKind: z
        .enum(['water', 'food', 'fuel', 'pharmacy', 'store', 'power', 'equipment', 'other'])
        .optional(),
      /** A place name or landmark, never a person (SEC-10). */
      place: z.string().max(200).optional(),
      note,
      position: point.optional(),
    }),
    async values(b, ctx) {
      const site = b['category'] === 'site_status';
      if (site && (!b['siteId'] || !b['siteStatus']))
        throw errors.validation([
          { name: 'siteStatus', message: 'a site status names the site and what was seen there' },
        ]);
      if (!site && !b['resourceKind'])
        throw errors.validation([
          { name: 'resourceKind', message: 'a resource seen says what kind of resource' },
        ]);
      if (site) {
        const known = await ctx.trx
          .selectFrom('cg.site')
          .select('id')
          .where('id', '=', b['siteId'] as string)
          .executeTakeFirst();
        if (!known) throw errors.validation([{ name: 'siteId', message: 'unknown site' }]);
      }
      const p = b['position'] as z.infer<typeof point> | undefined;
      return {
        event_id: ctx.eventId,
        category: b['category'],
        site_id: site ? b['siteId'] : null,
        site_status: site ? b['siteStatus'] : null,
        resource_kind: site ? null : b['resourceKind'],
        place: b['place'] ?? null,
        note: b['note'] ?? null,
        geom: p ? sql`ST_SetSRID(ST_MakePoint(${p.lon}, ${p.lat}), 4326)` : null,
        accuracy_m: p?.accuracyM ?? null,
        reported_by: ctx.accountId,
        reported_personnel_id: ctx.personnelId,
      };
    },
    async out(r) {
      return {
        ...common(r),
        eventId: str(r['event_id']),
        category: str(r['category']),
        siteId: str(r['site_id']),
        siteStatus: str(r['site_status']),
        resourceKind: str(r['resource_kind']),
        place: str(r['place']),
        note: str(r['note']),
        reportedAt: date(r['reported_at']),
        notedAt: date(r['noted_at']),
      };
    },
    summary: (b) =>
      b['category'] === 'site_status'
        ? `Site seen ${String(b['siteStatus'])}`
        : `Resource seen: ${String(b['resourceKind'])}${b['place'] ? ` at ${String(b['place'])}` : ''}`,
    activity: 'note',
  },
};

export const FIELD_RECORD_KINDS = Object.keys(SPECS);

const outAny = z.record(z.string(), z.unknown());

export const fieldRecordRoutes =
  (deps: FieldRecordDeps = {}): FastifyPluginAsync =>
  async (instance) => {
    const app = instance.withTypeProvider<ZodTypeProvider>();

    const account = (request: FastifyRequest) => {
      const s = request.subject;
      if (s.kind !== 'account') throw errors.unauthorized();
      return s;
    };

    async function context(request: FastifyRequest, trx: Trx, eventId?: string): Promise<Ctx> {
      const s = account(request);
      const person = await trx
        .selectFrom('cg.personnel')
        .select('id')
        .where('account_id', '=', s.accountId)
        .executeTakeFirst();
      const open = person
        ? await trx
            .selectFrom('cg.check_in')
            .select(['event_id', 'team_id'])
            .where('personnel_id', '=', person.id)
            .where('ended_at', 'is', null)
            .executeTakeFirst()
        : undefined;
      const crypto = instance.fieldCrypto;
      return {
        request,
        trx,
        tenantId: s.tenantId,
        accountId: s.accountId,
        personnelId: person?.id ?? null,
        teamId: open?.team_id ?? null,
        eventId: eventId ?? open?.event_id ?? null,
        enc: (text) => crypto.encrypt(s.tenantId, text),
        // Fails closed per field: a value that cannot be decrypted is withheld and logged, not shown
        // and not allowed to hide the rest of the answer (SEC-10).
        dec: async (blob) => {
          if (!Buffer.isBuffer(blob)) return null;
          try {
            return await crypto.decrypt(s.tenantId, blob);
          } catch (err) {
            request.log.error({ err }, 'a restricted field could not be decrypted');
            return null;
          }
        },
        async location(b) {
          if (!b.parcelId && !b.position && !b.landmark) return { id: null, usng: null };
          const usng = b.position ? toUsng(b.position.lat, b.position.lon) : null;
          const row = await trx
            .insertInto('cg.location')
            .values({
              tenant_id: s.tenantId,
              landmark: b.landmark ?? null,
              geom: b.position
                ? sql`ST_SetSRID(ST_MakePoint(${b.position.lon}, ${b.position.lat}), 4326)`
                : null,
              precision: b.position
                ? (b.position.accuracyM ?? 0) <= 30
                  ? 'exact'
                  : 'approximate'
                : 'unknown',
              source: 'field',
              parcel_id: b.parcelId ?? null,
              usng,
              created_by: s.accountId,
              updated_by: s.accountId,
            })
            .returning('id')
            .executeTakeFirstOrThrow();
          return { id: row.id, usng };
        },
        async putSignature(id, svg) {
          const objects = deps.objects;
          if (!objects)
            throw new ApiError(
              503,
              'signatures_unavailable',
              'Signatures cannot be saved right now.',
              {
                retryable: true,
              },
            );
          const key = `tenants/${s.tenantId}/signatures/${id}.svg.enc`;
          const { PutObjectCommand } = await import('@aws-sdk/client-s3');
          await objects.client.send(
            new PutObjectCommand({
              Bucket: objects.bucket,
              Key: key,
              Body: await crypto.encrypt(s.tenantId, svg),
              ContentType: 'application/octet-stream',
            }),
          );
          return key;
        },
      };
    }

    const specOf = (kind: string) => {
      const spec = SPECS[kind];
      if (!spec) throw errors.notFound();
      return spec;
    };
    const kindParam = z.object({ kind: z.enum(FIELD_RECORD_KINDS as [string, ...string[]]) });

    /** SEC-18: a read of restricted details is audited, one entry per answer. */
    async function auditRead(request: FastifyRequest, trx: Trx, spec: Spec, ids: string[]) {
      if (!spec.restricted || ids.length === 0) return;
      await request.audit(trx, {
        action: spec.read,
        targetType: spec.table.replace('cg.', ''),
        targetId: ids[0]!,
        changes: { fields: [{ name: 'records_read', to: ids.length }] },
      });
    }

    // --------------------------------------------------------------- create
    app.post(
      '/field-records/:kind',
      {
        schema: {
          tags: ['field'],
          params: kindParam,
          body: z.record(z.string(), z.unknown()),
          response: { 200: outAny, 201: outAny },
        },
      },
      async (request, reply) => {
        const s = account(request);
        const spec = specOf(request.params.kind);
        await request.authorize(spec.write, {
          type: spec.table.replace('cg.', ''),
          tenantId: s.tenantId,
        });
        const parsed = spec.body.safeParse(request.body);
        if (!parsed.success)
          throw errors.validation(
            parsed.error.issues.map((i) => ({ name: i.path.join('.'), message: i.message })),
          );
        const b = parsed.data as Record<string, unknown>;
        const extra: Record<string, unknown> = {};
        const { out, created } = await request.tx(async (trx) => {
          const t = loose(trx);
          const ctx = await context(request, trx, b['eventId'] as string | undefined);
          const existing = (await t
            .selectFrom(spec.table)
            .selectAll()
            .where('client_uuid', '=', b['clientUuid'])
            .executeTakeFirst()) as Row | undefined;
          if (existing) return { out: await spec.out(existing, ctx), created: false };
          if (spec.needsEvent && !ctx.eventId)
            throw errors.validation([{ name: 'eventId', message: 'check in to an event first' }]);
          const values = await spec.values(b, ctx);
          const isStamped = spec.table !== 'cg.shelter_incident';
          const row = (await t
            .insertInto(spec.table)
            .values({
              tenant_id: s.tenantId,
              client_uuid: b['clientUuid'],
              ...values,
              ...(isStamped ? { created_by: s.accountId, updated_by: s.accountId } : {}),
            })
            .returningAll()
            .executeTakeFirstOrThrow()) as Row;
          if (spec.table === 'cg.child_check_in') {
            // FR-26: the guardian's pickup code is shown once; only its hash is kept.
            const code = newCode();
            await t
              .updateTable(spec.table)
              .set({ pickup_code_hash: sha([s.tenantId, 'pickup', code]) })
              .where('id', '=', row.id)
              .execute();
            extra['pickupCode'] = code;
          }
          if (spec.table === 'cg.shelter_stay') {
            // FR-14: the wristband code for the door; only its hash is kept.
            const code = newCode();
            await t
              .updateTable(spec.table)
              .set({ wristband_code_hash: sha([s.tenantId, 'wristband', code]) })
              .where('id', '=', row.id)
              .execute();
            extra['wristbandCode'] = code;
          }
          if (spec.created) await spec.created(b, ctx, extra);
          if (spec.after) await spec.after(b, row, ctx);
          const eventForLog = (row['event_id'] as string | undefined) ?? ctx.eventId;
          // The ICS 214 log is per person or team (FLD-03); an account with neither has no log to add to.
          if (spec.activity && spec.summary && eventForLog && (ctx.personnelId || ctx.teamId))
            await trx
              .insertInto('cg.activity_entry')
              .values({
                tenant_id: s.tenantId,
                event_id: eventForLog,
                personnel_id: ctx.personnelId,
                team_id: ctx.teamId,
                kind: spec.activity,
                summary: spec.summary(b),
                ref_kind: spec.table.replace('cg.', ''),
                ref_id: row.id,
                actor_account_id: s.accountId,
              })
              .execute();
          await request.audit(trx, {
            action: spec.write,
            targetType: spec.table.replace('cg.', ''),
            targetId: row.id,
            changes: {
              fields: Object.keys(values)
                .filter((k) => !k.endsWith('_enc') && k !== 'geom')
                .slice(0, 12)
                .map((k) => ({
                  name: k,
                  to: typeof values[k] === 'object' ? '[set]' : (values[k] as string | number),
                })),
            },
          });
          return { out: await spec.out(row, ctx), created: true };
        });
        if (created && spec.afterCommit) {
          try {
            const follow = await spec.afterCommit(b, out, request, instance);
            if (follow.residentMessage) extra['residentMessage'] = follow.residentMessage;
          } catch (err) {
            request.log.warn({ err }, 'a follow-up after a field record did not run');
          }
        }
        return reply.code(created ? 201 : 200).send({ ...out, ...extra });
      },
    );

    // ----------------------------------------------------------------- list
    app.get(
      '/field-records/:kind',
      {
        schema: {
          tags: ['field'],
          params: kindParam,
          querystring: listQuery.extend({
            eventId: z.uuid().optional(),
            siteId: z.uuid().optional(),
            missionId: z.uuid().optional(),
            needId: z.uuid().optional(),
            reportId: z.uuid().optional(),
            shelterStayId: z.uuid().optional(),
            parcelId: z.string().max(80).optional(),
            status: z.string().max(40).optional(),
            state: z.string().max(40).optional(),
            outcome: z.string().max(40).optional(),
            result: z.string().max(40).optional(),
            kind: z.string().max(40).optional(),
            phase: z.string().max(40).optional(),
            language: z.string().max(40).optional(),
            debrisType: z.string().max(40).optional(),
            requestStatus: z.string().max(40).optional(),
            /** Shelter stays and children still in. */
            open: z.coerce.boolean().optional(),
          }),
          response: { 200: z.array(outAny) },
        },
      },
      async (request) => {
        const s = account(request);
        const spec = specOf(request.params.kind);
        const decision = await request.authorize(spec.read, {
          type: spec.table.replace('cg.', ''),
          tenantId: s.tenantId,
        });
        const q = request.query as Record<string, unknown>;
        return request.tx(async (trx) => {
          const ctx = await context(request, trx);
          let x = loose(trx)
            .selectFrom(spec.table)
            .selectAll()
            .orderBy(spec.orderColumn, 'desc')
            .limit(q['limit'] as number)
            .offset(q['offset'] as number);
          for (const [name, column] of Object.entries(spec.filters))
            if (q[name] !== undefined) x = x.where(column, '=', q[name]);
          if (q['open'] && (spec.table === 'cg.shelter_stay' || spec.table === 'cg.child_check_in'))
            x = x.where('checked_out_at', 'is', null);
          if (decision.recordScope === 'own')
            x = x.where(spec.ownColumn ?? 'created_by', '=', s.accountId);
          const rows = (await x.execute()) as Row[];
          await auditRead(
            request,
            trx,
            spec,
            rows.map((r) => r.id),
          );
          return Promise.all(rows.map((r) => spec.out(r, ctx)));
        });
      },
    );

    /** Loads one record the caller may act on, or a 404 (no hint that it exists, ADM-05). */
    async function one(
      request: FastifyRequest,
      trx: Trx,
      spec: Spec,
      id: string,
      own: boolean,
    ): Promise<Row> {
      const s = account(request);
      let x = loose(trx).selectFrom(spec.table).selectAll().where('id', '=', id);
      if (own) x = x.where(spec.ownColumn ?? 'created_by', '=', s.accountId);
      const r = (await x.executeTakeFirst()) as Row | undefined;
      if (!r) throw errors.notFound();
      return r;
    }

    async function transition(
      request: FastifyRequest,
      kind: string,
      action: string,
      id: string,
      apply: (r: Row, ctx: Ctx) => Promise<Record<string, unknown>>,
      changes: (r: Row) => { name: string; to: string | number | null }[],
    ) {
      const s = account(request);
      const spec = specOf(kind);
      const decision = await request.authorize(action, {
        type: spec.table.replace('cg.', ''),
        tenantId: s.tenantId,
      });
      return request.tx(async (trx) => {
        const ctx = await context(request, trx);
        const r = await one(request, trx, spec, id, decision.recordScope === 'own');
        const set = await apply(r, ctx);
        const updated = (await loose(trx)
          .updateTable(spec.table)
          .set({ ...set, updated_by: s.accountId })
          .where('id', '=', id)
          .returningAll()
          .executeTakeFirstOrThrow()) as Row;
        await request.audit(trx, {
          action,
          targetType: spec.table.replace('cg.', ''),
          targetId: id,
          changes: { fields: changes(updated) },
        });
        return spec.out(updated, ctx);
      });
    }

    // FL:FR-05: a road reopens.
    app.post(
      '/field-records/road_status/:id/clear',
      { schema: { tags: ['field'], params: uuidParam, response: { 200: outAny } } },
      (request) =>
        transition(
          request,
          'road_status',
          'road_status.write',
          request.params.id,
          async (r) => {
            if (r['cleared_at'])
              throw new ApiError(409, 'already_cleared', 'This road is already open.');
            return { status: 'cleared', cleared_at: new Date() };
          },
          () => [{ name: 'status', to: 'cleared' }],
        ),
    );

    // FLD-11: dispatch has read a quick report from the field.
    app.post(
      '/field-records/field_report/:id/note',
      { schema: { tags: ['field'], params: uuidParam, response: { 200: outAny } } },
      (request) =>
        transition(
          request,
          'field_report',
          'field_report.note',
          request.params.id,
          async (r) => {
            if (r['noted_at'])
              throw new ApiError(409, 'already_noted', 'This report is already marked noted.');
            return { noted_at: new Date(), noted_by: account(request).accountId };
          },
          () => [{ name: 'noted', to: 'yes' }],
        ),
    );

    // ---------------------------------------------------- pets (FL:FR-08)
    type PetStatus = Database['cg.pet_intake']['status'] extends import('kysely').Generated<infer S>
      ? S
      : never;
    const LOST: PetStatus[] = ['lost_report'];
    const FOUND: PetStatus[] = ['sheltered', 'found_report'];
    /** Words a description carries, for suggesting matches: lower case, three letters or more. */
    const STOP = new Set([
      'the',
      'and',
      'with',
      'has',
      'very',
      'was',
      'not',
      'one',
      'una',
      'uno',
      'con',
      'del',
      'las',
      'los',
      'por',
      'sin',
      'que',
      'muy',
      'tiene',
    ]);
    const words = (text: unknown) =>
      new Set(
        String(text ?? '')
          .toLowerCase()
          .split(/[^\p{L}\p{N}]+/u)
          .filter((w) => w.length >= 3 && !STOP.has(w)),
      );

    // FL:FR-08: how many animals each shelter holds now, by kind of animal.
    app.get(
      '/field-records/pet_intake/census',
      {
        schema: {
          tags: ['field'],
          querystring: z.object({ eventId: z.uuid().optional() }),
          response: {
            200: z.array(
              z.object({
                siteId: z.uuid().nullable(),
                siteName: z.string().nullable(),
                total: z.number().int(),
                bySpecies: z.record(z.string(), z.number().int()),
              }),
            ),
          },
        },
      },
      async (request) => {
        const s = account(request);
        await request.authorize('pet_intake.read', { type: 'pet_intake', tenantId: s.tenantId });
        const rows = await request.tx((trx) => {
          let x = trx
            .selectFrom('cg.pet_intake as p')
            .leftJoin('cg.site as s', 's.id', 'p.site_id')
            .select([
              'p.site_id',
              's.name as site_name',
              'p.species',
              sql<string>`count(*)`.as('n'),
            ])
            .where('p.status', '=', 'sheltered')
            .where('p.released_at', 'is', null)
            .groupBy(['p.site_id', 's.name', 'p.species'])
            .orderBy('s.name')
            .orderBy('p.species');
          if (request.query.eventId) x = x.where('p.event_id', '=', request.query.eventId);
          return x.execute();
        });
        const bySite = new Map<
          string,
          {
            siteId: string | null;
            siteName: string | null;
            total: number;
            bySpecies: Record<string, number>;
          }
        >();
        for (const r of rows) {
          const key = r.site_id ?? 'none';
          const entry = bySite.get(key) ?? {
            siteId: r.site_id,
            siteName: r.site_name,
            total: 0,
            bySpecies: {},
          };
          entry.total += Number(r.n);
          entry.bySpecies[r.species] = (entry.bySpecies[r.species] ?? 0) + Number(r.n);
          bySite.set(key, entry);
        }
        return [...bySite.values()];
      },
    );

    // FL:FR-08: possible matches for a lost report (animals found or sheltered) or the other
    // way round, in the same event and kind of animal, with the words the descriptions share.
    // Only suggestions: a person confirms a match.
    app.get(
      '/field-records/pet_intake/:id/candidates',
      {
        schema: {
          tags: ['field'],
          params: uuidParam,
          response: {
            200: z.array(z.object({ record: outAny, shared: z.array(z.string()) })),
          },
        },
      },
      async (request) => {
        const s = account(request);
        await request.authorize('pet_intake.read', { type: 'pet_intake', tenantId: s.tenantId });
        return request.tx(async (trx) => {
          const ctx = await context(request, trx);
          const self = await trx
            .selectFrom('cg.pet_intake')
            .selectAll()
            .where('id', '=', request.params.id)
            .executeTakeFirst();
          if (!self) throw errors.notFound();
          const lost = LOST.includes(self.status);
          if (!lost && !FOUND.includes(self.status)) return [];
          const others = await trx
            .selectFrom('cg.pet_intake')
            .selectAll()
            .where('event_id', '=', self.event_id)
            .where('id', '<>', self.id)
            .where('matched_with', 'is', null)
            .where('status', 'in', lost ? FOUND : LOST)
            .where(sql<boolean>`lower(species) = lower(${self.species})`)
            .orderBy('intake_at', 'desc')
            .limit(100)
            .execute();
          const mine = words(self.description);
          const scored = others
            .map((o) => ({ o, shared: [...words(o.description)].filter((w) => mine.has(w)) }))
            .sort((a, b) => b.shared.length - a.shared.length)
            .slice(0, 10);
          return Promise.all(
            scored.map(async ({ o, shared }) => ({
              record: await SPECS['pet_intake']!.out(o as unknown as Row, ctx),
              shared,
            })),
          );
        });
      },
    );

    // FL:FR-08: a person confirms a lost report and a found or sheltered animal are the same pet.
    app.post(
      '/field-records/pet_intake/:id/match',
      {
        schema: {
          tags: ['field'],
          params: uuidParam,
          body: z.object({ otherId: z.uuid() }),
          response: { 200: outAny },
        },
      },
      async (request) => {
        const s = account(request);
        await request.authorize('pet_intake.write', { type: 'pet_intake', tenantId: s.tenantId });
        return request.tx(async (trx) => {
          const ctx = await context(request, trx);
          const pair = await trx
            .selectFrom('cg.pet_intake')
            .selectAll()
            .where('id', 'in', [request.params.id, request.body.otherId])
            .forUpdate()
            .execute();
          const self = pair.find((p) => p.id === request.params.id);
          const other = pair.find((p) => p.id === request.body.otherId);
          if (!self || !other || self.id === other.id) throw errors.notFound();
          const sides = [self, other].map((p) =>
            LOST.includes(p.status) ? 'lost' : FOUND.includes(p.status) ? 'found' : 'other',
          );
          if (sides[0] === sides[1] || sides.includes('other') || self.event_id !== other.event_id)
            throw new ApiError(
              409,
              'not_a_pair',
              'A match is a lost report and an animal found or sheltered in the same event.',
            );
          if (self.matched_with || other.matched_with)
            throw new ApiError(409, 'already_matched', 'One of these is already matched.');
          const now = new Date();
          for (const [a, b] of [
            [self, other],
            [other, self],
          ] as const)
            await trx
              .updateTable('cg.pet_intake')
              .set({
                matched_with: b.id,
                matched_at: now,
                matched_by: s.accountId,
                updated_by: s.accountId,
              })
              .where('id', '=', a.id)
              .execute();
          await request.audit(trx, {
            action: 'pet_intake.write',
            targetType: 'pet_intake',
            targetId: self.id,
            changes: { fields: [{ name: 'matched_with', to: other.id }] },
          });
          const updated = await trx
            .selectFrom('cg.pet_intake')
            .selectAll()
            .where('id', '=', self.id)
            .executeTakeFirstOrThrow();
          return SPECS['pet_intake']!.out(updated as unknown as Row, ctx);
        });
      },
    );

    // FL:FR-17: the crew leaves a stop. It names the check-in by the phone's id, so it works
    // offline before the server has seen either; a resend changes nothing.
    app.post(
      '/field-records/canteen_stop/check-out',
      {
        schema: {
          tags: ['field'],
          body: z.object({
            stopClientUuid: z.uuid(),
            departedAt: z.iso.datetime().optional(),
            mealsServed: z.number().int().min(0).max(100_000).optional(),
            suppliesLeft: z.string().max(300).optional(),
            /** About the food, never who has an allergy (plan reading 27). */
            allergenNote: z.string().max(300).optional(),
          }),
          response: { 200: outAny },
        },
      },
      async (request) => {
        const s = account(request);
        const decision = await request.authorize('canteen_stop.write', {
          type: 'canteen_stop',
          tenantId: s.tenantId,
        });
        const b = request.body;
        return request.tx(async (trx) => {
          const ctx = await context(request, trx);
          let x = trx
            .selectFrom('cg.canteen_stop')
            .selectAll()
            .where('client_uuid', '=', b.stopClientUuid)
            .forUpdate();
          if (decision.recordScope === 'own') x = x.where('created_by', '=', s.accountId);
          const stop = await x.executeTakeFirst();
          if (!stop) throw errors.notFound();
          if (stop.departed_at) return SPECS['canteen_stop']!.out(stop as unknown as Row, ctx);
          const departed = b.departedAt ? new Date(b.departedAt) : new Date();
          if (departed < stop.arrived_at)
            throw errors.validation([
              { name: 'departedAt', message: 'the crew left before it arrived' },
            ]);
          const updated = await trx
            .updateTable('cg.canteen_stop')
            .set({
              departed_at: departed,
              meals_served: b.mealsServed ?? null,
              supplies_left: b.suppliesLeft ?? null,
              allergen_note: b.allergenNote ?? null,
              updated_by: s.accountId,
            })
            .where('id', '=', stop.id)
            .returningAll()
            .executeTakeFirstOrThrow();
          await request.audit(trx, {
            action: 'canteen_stop.write',
            targetType: 'canteen_stop',
            targetId: stop.id,
            changes: {
              fields: [
                { name: 'departed', to: 'yes' },
                { name: 'meals_served', to: b.mealsServed ?? null },
              ],
            },
          });
          return SPECS['canteen_stop']!.out(updated as unknown as Row, ctx);
        });
      },
    );

    // FL:FR-08: the pet went home: both matched records say so.
    app.post(
      '/field-records/pet_intake/:id/reunite',
      { schema: { tags: ['field'], params: uuidParam, response: { 200: outAny } } },
      async (request) => {
        const s = account(request);
        await request.authorize('pet_intake.write', { type: 'pet_intake', tenantId: s.tenantId });
        return request.tx(async (trx) => {
          const ctx = await context(request, trx);
          const self = await trx
            .selectFrom('cg.pet_intake')
            .selectAll()
            .where('id', '=', request.params.id)
            .forUpdate()
            .executeTakeFirst();
          if (!self) throw errors.notFound();
          if (!self.matched_with)
            throw new ApiError(409, 'not_matched', 'Confirm the match before the pet goes home.');
          if (self.status === 'reunited')
            throw new ApiError(409, 'already_reunited', 'This pet is already home.');
          const now = new Date();
          await trx
            .updateTable('cg.pet_intake')
            .set({ status: 'reunited', released_at: now, updated_by: s.accountId })
            .where('id', 'in', [self.id, self.matched_with])
            .execute();
          await request.audit(trx, {
            action: 'pet_intake.write',
            targetType: 'pet_intake',
            targetId: self.id,
            changes: { fields: [{ name: 'status', from: self.status, to: 'reunited' }] },
          });
          const updated = await trx
            .selectFrom('cg.pet_intake')
            .selectAll()
            .where('id', '=', self.id)
            .executeTakeFirstOrThrow();
          return SPECS['pet_intake']!.out(updated as unknown as Row, ctx);
        });
      },
    );

    // FL:FR-14: a guest leaves the shelter.
    app.post(
      '/field-records/shelter_stay/:id/check-out',
      {
        schema: {
          tags: ['field'],
          params: uuidParam,
          body: z.object({ reason: z.string().max(200).optional() }),
          response: { 200: outAny },
        },
      },
      (request) =>
        transition(
          request,
          'shelter_stay',
          'shelter_stay.write',
          request.params.id,
          async (r) => {
            if (r['checked_out_at'])
              throw new ApiError(409, 'already_checked_out', 'This household has already left.');
            return { checked_out_at: new Date(), checked_out_reason: request.body.reason ?? null };
          },
          () => [{ name: 'checked_out', to: 'yes' }],
        ),
    );

    // FL:FR-14: the shelter door scans or types a wristband code.
    app.post(
      '/field-records/shelter_stay/lookup',
      {
        schema: {
          tags: ['field'],
          body: z.object({ code: z.string().min(4).max(20), siteId: z.uuid().optional() }),
          response: { 200: outAny },
        },
      },
      async (request) => {
        const s = account(request);
        const spec = specOf('shelter_stay');
        await request.authorize('shelter_stay.read', {
          type: 'shelter_stay',
          tenantId: s.tenantId,
        });
        return request.tx(async (trx) => {
          const ctx = await context(request, trx);
          let x = loose(trx)
            .selectFrom('cg.shelter_stay')
            .selectAll()
            .where(
              'wristband_code_hash',
              '=',
              sha([s.tenantId, 'wristband', normCode(request.body.code)]),
            );
          if (request.body.siteId) x = x.where('site_id', '=', request.body.siteId);
          const r = (await x.executeTakeFirst()) as Row | undefined;
          if (!r) throw errors.notFound();
          await auditRead(request, trx, spec, [r.id]);
          return spec.out(r, ctx);
        });
      },
    );

    // FL:FR-14: the census for a shelter from the stays still open; counts only.
    app.get(
      '/field-records/shelter_stay/census',
      {
        schema: {
          tags: ['field'],
          querystring: z.object({ siteId: z.uuid() }),
          response: {
            200: z.object({
              siteId: z.uuid(),
              households: z.number().int(),
              people: z.number().int(),
              children: z.number().int(),
              pets: z.number().int(),
              cotsInUse: z.array(z.string()),
            }),
          },
        },
      },
      async (request) => {
        const s = account(request);
        await request.authorize('shelter_stay.read', {
          type: 'shelter_stay',
          tenantId: s.tenantId,
        });
        const rows = await request.tx((trx) =>
          trx
            .selectFrom('cg.shelter_stay')
            .select(['household_size', 'children', 'pets', 'cots'])
            .where('site_id', '=', request.query.siteId)
            .where('checked_out_at', 'is', null)
            .execute(),
        );
        return {
          siteId: request.query.siteId,
          households: rows.length,
          people: rows.reduce((n, r) => n + r.household_size, 0),
          children: rows.reduce((n, r) => n + r.children, 0),
          pets: rows.reduce((n, r) => n + r.pets, 0),
          cotsInUse: rows.flatMap((r) => r.cots).sort(),
        };
      },
    );

    // FL:FR-26: a child goes home only with the right pickup code; a wrong code is audited.
    app.post(
      '/field-records/child_check_in/:id/check-out',
      {
        schema: {
          tags: ['field'],
          params: uuidParam,
          body: z.object({
            pickupCode: z.string().min(4).max(20),
            releasedTo: z.string().min(1).max(120),
          }),
          response: { 200: outAny },
        },
      },
      async (request) => {
        const s = account(request);
        const spec = specOf('child_check_in');
        await request.authorize('child_check_in.write', {
          type: 'child_check_in',
          tenantId: s.tenantId,
        });
        const b = request.body;
        const result = await request.tx(async (trx) => {
          const ctx = await context(request, trx);
          const r = await one(request, trx, spec, request.params.id, false);
          if (r['checked_out_at'])
            throw new ApiError(
              409,
              'already_checked_out',
              'This child has already been picked up.',
            );
          const given = sha([s.tenantId, 'pickup', normCode(b.pickupCode)]);
          const kept = r['pickup_code_hash'] as Buffer;
          if (!Buffer.isBuffer(kept) || !kept.equals(given)) {
            await request.audit(trx, {
              action: 'child_check_in.pickup_refused',
              targetType: 'child_check_in',
              targetId: r.id,
              changes: { fields: [{ name: 'pickup_code', to: 'did not match' }] },
            });
            return { refused: true as const };
          }
          const updated = (await loose(trx)
            .updateTable('cg.child_check_in')
            .set({
              checked_out_at: new Date(),
              checked_out_to_enc: await ctx.enc(b.releasedTo),
              updated_by: s.accountId,
            })
            .where('id', '=', r.id)
            .returningAll()
            .executeTakeFirstOrThrow()) as Row;
          await request.audit(trx, {
            action: 'child_check_in.write',
            targetType: 'child_check_in',
            targetId: r.id,
            changes: { fields: [{ name: 'checked_out', to: 'yes' }] },
          });
          return { refused: false as const, out: await spec.out(updated, ctx) };
        });
        // The refusal is committed (audited) before the answer says no.
        if (result.refused)
          throw new ApiError(
            403,
            'pickup_code_mismatch',
            'That pickup code does not match. Do not release the child; ask a lead.',
          );
        return result.out;
      },
    );

    // FL:FR-24: an interpreter accepts, starts, finishes; the requester may cancel.
    app.post(
      '/field-records/interpreter_request/:id/respond',
      {
        schema: {
          tags: ['field'],
          params: uuidParam,
          body: z.object({
            state: z.enum(['accepted', 'in_progress', 'done', 'canceled']),
            minutes: z
              .number()
              .int()
              .min(0)
              .max(24 * 60)
              .optional(),
          }),
          response: { 200: outAny },
        },
      },
      async (request) => {
        const s = account(request);
        const b = request.body;
        const cancel = b.state === 'canceled';
        // The requester cancels their own request; everything else is the interpreter's.
        return transition(
          request,
          'interpreter_request',
          cancel ? 'interpreter.request' : 'interpreter.respond',
          request.params.id,
          async (r, ctx) => {
            const next: Record<string, string[]> = {
              open: ['accepted', 'canceled'],
              accepted: ['in_progress', 'done', 'canceled'],
              in_progress: ['done'],
            };
            const from = String(r['state']);
            if (!next[from]?.includes(b.state))
              throw new ApiError(
                409,
                'invalid_transition',
                `A request that is ${from} cannot become ${b.state}.`,
              );
            if (cancel && r['requested_by'] !== s.accountId) throw errors.notFound();
            if (
              !cancel &&
              r['interpreter_personnel_id'] &&
              r['interpreter_personnel_id'] !== ctx.personnelId
            )
              throw new ApiError(409, 'taken', 'Another interpreter has this request.');
            return {
              state: b.state,
              ...(b.state === 'accepted'
                ? { interpreter_personnel_id: ctx.personnelId, accepted_at: new Date() }
                : {}),
              ...(b.state === 'done' ? { done_at: new Date(), minutes: b.minutes ?? null } : {}),
            };
          },
          (u) => [{ name: 'state', to: String(u['state']) }],
        );
      },
    );

    // FL:FR-19: the release, signed after the work.
    app.post(
      '/field-records/right_of_entry/:id/release',
      {
        schema: {
          tags: ['field'],
          params: uuidParam,
          body: z.object({ signatureSvg: z.string().min(8).max(SIGNATURE_MAX) }),
          response: { 200: outAny },
        },
      },
      (request) =>
        transition(
          request,
          'right_of_entry',
          'right_of_entry.write',
          request.params.id,
          async (r, ctx) => {
            if (r['release_signed_at'])
              throw new ApiError(409, 'already_released', 'The release is already signed.');
            const key = await ctx.putSignature(`${r.id}-release`, request.body.signatureSvg);
            return { release_signed_at: new Date(), release_signature_key: key };
          },
          () => [{ name: 'release_signed', to: 'yes' }],
        ),
    );

    // ------------------------------------------------------------------ stock
    /**
     * FL:FR-21, FR-22: stock per site and append-only movements by the phone's
     * id. Received and adjusted add, issued and transferred take away, a count
     * sets the quantity, a request changes nothing; "running low" is said when
     * the quantity reaches the reorder point.
     */
    app.post(
      '/field-records/stock_movement',
      {
        schema: {
          tags: ['field'],
          body: z.object({
            clientUuid: z.uuid(),
            stockItemId: z.uuid().optional(),
            item: z
              .object({
                siteId: z.uuid(),
                sku: z.string().min(1).max(60),
                name: z.string().min(1).max(120),
                unit: z.string().min(1).max(20).default('each'),
                barcode: z.string().max(60).optional(),
                reorderAt: z.number().min(0).optional(),
              })
              .optional(),
            kind: z.enum(['received', 'issued', 'counted', 'transferred', 'adjusted', 'requested']),
            quantity: z.number().min(-1_000_000).max(1_000_000),
            toSiteId: z.uuid().optional(),
            missionId: z.uuid().optional(),
            note: z.string().max(500).optional(),
          }),
          response: {
            200: z.object({
              movementId: z.uuid(),
              stockItemId: z.uuid(),
              quantity: z.number(),
              runningLow: z.boolean(),
              /** FL:FR-22: the site's resupply draft gained this item; a person sends it. */
              resupplyDrafted: z.boolean(),
            }),
          },
        },
      },
      async (request) => {
        const s = account(request);
        await request.authorize('stock.write', { type: 'stock_item', tenantId: s.tenantId });
        const b = request.body;
        if (!b.stockItemId && !b.item)
          throw errors.validation([
            { name: 'stockItemId', message: 'name the item or describe a new one' },
          ]);
        if (b.kind !== 'adjusted' && b.quantity < 0)
          throw errors.validation([
            { name: 'quantity', message: 'only an adjustment can be negative' },
          ]);
        return request.tx(async (trx) => {
          const seen = await trx
            .selectFrom('cg.stock_movement as m')
            .innerJoin('cg.stock_item as i', 'i.id', 'm.stock_item_id')
            .select(['m.id', 'm.stock_item_id', 'i.quantity', 'i.reorder_at'])
            .where('m.client_uuid', '=', b.clientUuid)
            .executeTakeFirst();
          const low = (q: unknown, at: unknown) => at !== null && Number(q) <= Number(at);
          if (seen)
            return {
              movementId: seen.id,
              stockItemId: seen.stock_item_id,
              quantity: Number(seen.quantity),
              runningLow: low(seen.quantity, seen.reorder_at),
              resupplyDrafted: false,
            };
          let itemId = b.stockItemId;
          if (!itemId && b.item) {
            const found = await trx
              .selectFrom('cg.stock_item')
              .select('id')
              .where('site_id', '=', b.item.siteId)
              .where('sku', '=', b.item.sku)
              .executeTakeFirst();
            itemId =
              found?.id ??
              (
                await trx
                  .insertInto('cg.stock_item')
                  .values({
                    tenant_id: s.tenantId,
                    site_id: b.item.siteId,
                    sku: b.item.sku,
                    name: b.item.name,
                    unit: b.item.unit,
                    barcode: b.item.barcode ?? null,
                    reorder_at: b.item.reorderAt !== undefined ? String(b.item.reorderAt) : null,
                    created_by: s.accountId,
                    updated_by: s.accountId,
                  })
                  .returning('id')
                  .executeTakeFirstOrThrow()
              ).id;
          }
          const item = await trx
            .selectFrom('cg.stock_item')
            .select(['id', 'site_id', 'name', 'unit', 'quantity', 'reorder_at'])
            .where('id', '=', itemId!)
            .executeTakeFirst();
          if (!item) throw errors.notFound();
          const q = Number(item.quantity);
          const nextQ =
            b.kind === 'received' || b.kind === 'adjusted'
              ? q + b.quantity
              : b.kind === 'issued' || b.kind === 'transferred'
                ? q - b.quantity
                : b.kind === 'counted'
                  ? b.quantity
                  : q;
          const movement = await trx
            .insertInto('cg.stock_movement')
            .values({
              tenant_id: s.tenantId,
              stock_item_id: item.id,
              kind: b.kind,
              quantity: String(b.quantity),
              to_site_id: b.toSiteId ?? null,
              mission_id: b.missionId ?? null,
              client_uuid: b.clientUuid,
              actor_account_id: s.accountId,
              note: b.note ?? null,
            })
            .returning('id')
            .executeTakeFirstOrThrow();
          if (nextQ !== q)
            await trx
              .updateTable('cg.stock_item')
              .set({ quantity: String(Math.max(0, nextQ)), updated_by: s.accountId })
              .where('id', '=', item.id)
              .execute();
          await request.audit(trx, {
            action: 'stock.write',
            targetType: 'stock_item',
            targetId: item.id,
            changes: {
              fields: [
                { name: 'movement', to: b.kind },
                { name: 'quantity', from: q, to: Math.max(0, nextQ) },
              ],
            },
          });
          // FL:FR-22: at the reorder point, the site's resupply draft gains the item.
          const runningLow = low(Math.max(0, nextQ), item.reorder_at);
          const drafted =
            runningLow && b.kind !== 'received' && b.kind !== 'requested'
              ? await draftResupply(trx, {
                  tenantId: s.tenantId,
                  accountId: s.accountId,
                  item,
                  quantity: Math.max(0, nextQ),
                })
              : null;
          return {
            movementId: movement.id,
            stockItemId: item.id,
            quantity: Math.max(0, nextQ),
            runningLow,
            resupplyDrafted: drafted !== null,
          };
        });
      },
    );

    app.get(
      '/field-records/stock_item',
      {
        schema: {
          tags: ['field'],
          querystring: listQuery.extend({
            siteId: z.uuid().optional(),
            barcode: z.string().max(60).optional(),
          }),
          response: {
            200: z.array(
              z.object({
                id: z.uuid(),
                siteId: z.uuid(),
                sku: z.string(),
                name: z.string(),
                unit: z.string(),
                quantity: z.number(),
                barcode: z.string().nullable(),
                reorderAt: z.number().nullable(),
                runningLow: z.boolean(),
                /** FL:FR-22: handed out or sent on in the last 24 hours, and how long what is left lasts at that rate. */
                usedLastDay: z.number(),
                hoursLeft: z.number().nullable(),
              }),
            ),
          },
        },
      },
      async (request) => {
        const s = account(request);
        await request.authorize('stock.read', { type: 'stock_item', tenantId: s.tenantId });
        const q = request.query;
        const rows = await request.tx((trx) => {
          let x = trx
            .selectFrom('cg.stock_item as i')
            .selectAll('i')
            .select(
              sql<string>`(select coalesce(sum(m.quantity), 0) from cg.stock_movement m
                where m.stock_item_id = i.id and m.kind in ('issued', 'transferred')
                and m.occurred_at > now() - interval '24 hours')`.as('used_last_day'),
            )
            .orderBy('name')
            .limit(q.limit)
            .offset(q.offset);
          if (q.siteId) x = x.where('i.site_id', '=', q.siteId);
          if (q.barcode) x = x.where('i.barcode', '=', q.barcode);
          return x.execute();
        });
        return rows.map((r) => ({
          id: r.id,
          siteId: r.site_id,
          sku: r.sku,
          name: r.name,
          unit: r.unit,
          quantity: Number(r.quantity),
          barcode: r.barcode,
          reorderAt: r.reorder_at === null ? null : Number(r.reorder_at),
          runningLow: r.reorder_at !== null && Number(r.quantity) <= Number(r.reorder_at),
          usedLastDay: Number(r.used_last_day),
          hoursLeft:
            Number(r.used_last_day) > 0
              ? Math.floor((Number(r.quantity) / Number(r.used_last_day)) * 24)
              : null,
        }));
      },
    );
  };
