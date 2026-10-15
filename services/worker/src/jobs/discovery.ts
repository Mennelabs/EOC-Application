/**
 * Proactive resource discovery (layer-7 task F; REC-13, REC-14; Q-06 as
 * decided 2026-10-15: partner posts first, the county's own sources, OpenAI
 * web search). On the tenant's schedule (weekly; daily while an event is
 * active) or when someone asks, the worker:
 *
 * 1. reads the services partner organizations posted (never a confidential
 *    site), the county's own feeds (HSDS, CSV, GeoJSON; public https only,
 *    ADR-0042) and, where enabled, web search;
 * 2. leaves out places already in the registry;
 * 3. drafts each new place as a candidate with its source links, what the
 *    source states, what is unknown, and the pre-check against the registry
 *    criteria. The same place found again refreshes its candidate. A rejected
 *    one stays rejected unless something about it has changed (REC-13).
 *
 * Nothing is added to, changed in or removed from the registry here: a person
 * qualifies each candidate in or out. Feeds and searches are read outside any
 * transaction, so a slow source holds no connection. A source that fails
 * leaves the others' results standing and says why in words.
 */
import { sql } from 'kysely';
import { publicGet, type PublicGet } from '@cg/adapters';
import { callAi, recordAiOutput, type AiProvider, type DiscoveredPlace } from '@cg/ai';
import { distanceKm } from '@cg/reporting';
import { allTenantIds, asSystem, systemAudit } from '../system.ts';
import {
  contentHashOf,
  fingerprintOf,
  kindFromText,
  placesFromFeed,
  precheck,
  unknownOf,
  type FoundPlace,
  type KnownAttributes,
} from '../discovery/places.ts';
import type { JobContext } from './types.ts';

const DAY = 86_400_000;
/** REC-13 defaults: weekly, daily during an active event (tenant `discovery.schedule`). */
export const QUIET_DAYS = 7;
export const ACTIVE_DAYS = 1;
/** A run still "running" after this long is marked failed (the worker stopped mid-run). */
const STUCK_MS = 60 * 60_000;
/** REC-14: a candidate this close to open requests for shelter or food during an active event is raised at once. */
export const NEAR_NEED_KM = 3;

const nowOf = (ctx: JobContext): Date => ctx.now?.() ?? new Date();

/** REC-13's kinds of place, unless the tenant sets `discovery.place_types`. */
export const PLACE_TYPES = [
  'community centers',
  'places of worship',
  'schools',
  'cooling and warming centers',
  'food pantries',
  'clinics',
  'large parking lots',
];
/** Places one search may return, and registered places it checks for changes. */
const SEARCH_MAX = 20;
const SEARCH_REGISTERED = 25;

/** A place the search found, as discovery keeps it (only what a page states). */
export function fromSearch(d: DiscoveredPlace): FoundPlace {
  const a: KnownAttributes = {};
  if (d.facts.sqft !== undefined) a.sqft = d.facts.sqft;
  if (d.facts.ada !== undefined) a.ada = d.facts.ada;
  if (d.facts.kitchen !== undefined) a.kitchen = d.facts.kitchen;
  if (d.facts.generator !== undefined) a.powerBackup = d.facts.generator ? 'generator' : 'none';
  if (d.facts.parkingSpaces !== undefined) a.parkingSpaces = d.facts.parkingSpaces;
  if (d.facts.hours !== undefined) a.hours = d.facts.hours;
  if (d.facts.website !== undefined) a.website = d.facts.website;
  return {
    name: d.name,
    kind: d.kind === 'other' ? kindFromText(d.name) : d.kind,
    address: d.address,
    position: d.position,
    attributes: a,
    sourceLinks: d.sourceUrls,
    ...(d.note ? { note: d.note } : {}),
    change: d.change,
    ...(d.registeredId ? { facilityId: d.registeredId } : {}),
  };
}

/**
 * REC-13's third source: OpenAI web search, only where the county lists it
 * and the AI use register has it switched on for the provider in force
 * (AIG-06, AIG-08). The search carries the area, the kinds of place and the
 * registered public places, never a person (AIG-05). It is called outside any
 * transaction and recorded whatever its outcome (AIG-01); when a page tried to
 * instruct it, nothing from that search is kept (AIG-02).
 */
async function webSearch(
  ctx: JobContext,
  tenantId: string,
  runId: string,
): Promise<{ outcome: string; places: FoundPlace[]; aiOutputId: string | null }> {
  const prep = await asSystem(ctx.db, tenantId, async (trx) => {
    const feature = await trx
      .selectFrom('cg.ai_use_register')
      .select(['enabled', 'provider'])
      .where('tenant_id', '=', tenantId)
      .where('feature', '=', 'discovery.web_search')
      .executeTakeFirst();
    if (!feature?.enabled) return { off: 'Web search is switched off in the AI use register.' };
    const provider: AiProvider | null = await ctx.ai.providerFor(tenantId, trx);
    if (!provider?.llm?.discoverPlaces || provider.info.provider !== feature.provider)
      return { off: 'No provider for web search is configured here.' };
    const config = await trx
      .selectFrom('cg.tenant_config')
      .select(['key', 'value'])
      .where('tenant_id', '=', tenantId)
      .where('key', 'in', ['discovery.area', 'discovery.place_types'])
      .execute();
    const tenant = await trx
      .selectFrom('cg.tenant')
      .select('name')
      .where('id', '=', tenantId)
      .executeTakeFirstOrThrow();
    const area = config.find((c) => c.key === 'discovery.area')?.value;
    const types = config.find((c) => c.key === 'discovery.place_types')?.value;
    const registered = await trx
      .selectFrom('cg.facility as f')
      .leftJoin('cg.location as l', 'l.id', 'f.location_id')
      .select(['f.id', 'f.name', 'l.line1', 'l.city'])
      .where('f.tenant_id', '=', tenantId)
      .where('f.status', '=', 'approved')
      .orderBy('f.last_confirmed_at')
      .limit(SEARCH_REGISTERED)
      .execute();
    return {
      provider,
      request: {
        area: typeof area === 'string' && area.trim() ? area.trim().slice(0, 200) : tenant.name,
        placeTypes:
          Array.isArray(types) && types.every((t) => typeof t === 'string') && types.length
            ? (types as string[]).slice(0, 20)
            : PLACE_TYPES,
        registered: registered.map((r) => ({
          id: r.id,
          name: r.name,
          address: [r.line1, r.city].filter(Boolean).join(', ') || null,
        })),
        max: SEARCH_MAX,
      },
    };
  });
  if ('off' in prep) return { outcome: prep.off!, places: [], aiOutputId: null };
  const call = await callAi(() => prep.provider.llm!.discoverPlaces!(prep.request));
  const injected = call.ok && call.out.output.injectionSuspected;
  const aiOutputId = await asSystem(ctx.db, tenantId, (trx) =>
    recordAiOutput(trx, {
      tenantId,
      feature: 'discovery.web_search',
      provider: call.ok ? call.out.provider : prep.provider.info,
      outcome: call.ok ? (injected ? 'filtered' : 'ok') : call.outcome,
      latencyMs: call.ok ? call.out.latencyMs : call.latencyMs,
      targetType: 'discovery_run',
      targetId: runId,
    }),
  );
  if (!call.ok)
    return { outcome: `The search did not answer (${call.outcome}).`, places: [], aiOutputId };
  if (injected)
    return {
      outcome: 'A page tried to instruct the search; nothing from this search was kept.',
      places: [],
      aiOutputId,
    };
  const out = call.out.output;
  return {
    outcome: `Found ${out.places.length} place${out.places.length === 1 ? '' : 's'}${out.dropped ? `; ${out.dropped} without a page the search cited were left out` : ''}.`,
    places: out.places.map(fromSearch),
    aiOutputId,
  };
}

export interface DiscoveryDeps {
  /** Reads a county feed; public https only by default (ADR-0042). */
  get?: PublicGet;
  /** Tests: only these tenants. */
  tenantIds?: string[];
}

interface SourceRow {
  id: string;
  kind: 'hsds' | 'csv' | 'geojson' | 'web_search';
  name: string;
  url: string | null;
}

interface Summary {
  partnerPosts: number;
  sources: { id: string; name: string; outcome: string; places: number }[];
  added: number;
  refreshed: number;
  alreadyRegistered: number;
  rememberedRejected: number;
  nearUnmetNeed: number;
}

/** Picks the run for a tenant: one asked for first, else a scheduled one when it is due. */
async function claimRun(ctx: JobContext, tenantId: string, now: Date): Promise<string | null> {
  return asSystem(ctx.db, tenantId, async (trx) => {
    await trx
      .updateTable('cg.discovery_run')
      .set({ state: 'failed', finished_at: now, summary: JSON.stringify({ error: 'stopped' }) })
      .where('tenant_id', '=', tenantId)
      .where('state', '=', 'running')
      .where('started_at', '<', new Date(now.getTime() - STUCK_MS))
      .execute();
    const asked = await trx
      .selectFrom('cg.discovery_run')
      .select('id')
      .where('tenant_id', '=', tenantId)
      .where('state', '=', 'requested')
      .orderBy('created_at')
      .limit(1)
      .forUpdate()
      .skipLocked()
      .executeTakeFirst();
    if (asked) {
      await trx
        .updateTable('cg.discovery_run')
        .set({ state: 'running', started_at: now })
        .where('id', '=', asked.id)
        .execute();
      return asked.id;
    }
    const last = await trx
      .selectFrom('cg.discovery_run')
      .select((eb) => eb.fn.max('created_at').as('at'))
      .where('tenant_id', '=', tenantId)
      .executeTakeFirst();
    const active = await trx
      .selectFrom('cg.event')
      .select('id')
      .where('tenant_id', '=', tenantId)
      .where('status', '=', 'active')
      .limit(1)
      .executeTakeFirst();
    const setting = await trx
      .selectFrom('cg.tenant_config')
      .select('value')
      .where('tenant_id', '=', tenantId)
      .where('key', '=', 'discovery.schedule')
      .executeTakeFirst();
    const s = (setting?.value ?? {}) as { quietDays?: unknown; activeDays?: unknown };
    const days = (v: unknown, d: number) =>
      typeof v === 'number' && Number.isFinite(v) && v >= 1 && v <= 90 ? v : d;
    const every = (active ? days(s.activeDays, ACTIVE_DAYS) : days(s.quietDays, QUIET_DAYS)) * DAY;
    const lastAt = last?.at ? new Date(last.at as Date) : null;
    if (lastAt && now.getTime() - lastAt.getTime() < every) return null;
    // Only when there is something to read.
    const source = await trx
      .selectFrom('cg.discovery_source')
      .select('id')
      .where('tenant_id', '=', tenantId)
      .where('enabled', '=', true)
      .limit(1)
      .executeTakeFirst();
    const posted = await trx
      .selectFrom('cg.site')
      .select('id')
      .where('tenant_id', '=', tenantId)
      .where('posted_by_tenant_id', 'is not', null)
      .where('confidential', '=', false)
      .limit(1)
      .executeTakeFirst();
    if (!source && !posted) return null;
    const run = await trx
      .insertInto('cg.discovery_run')
      .values({ tenant_id: tenantId, state: 'running', started_at: now, requested_by: null })
      .returning('id')
      .executeTakeFirstOrThrow();
    return run.id;
  });
}

/** Services partner organizations posted, as places (REC-13: the first source). */
async function partnerPosts(ctx: JobContext, tenantId: string): Promise<FoundPlace[]> {
  return asSystem(ctx.db, tenantId, async (trx) => {
    const rows = await trx
      .selectFrom('cg.site as s')
      .leftJoin('cg.location as l', 'l.id', 's.location_id')
      .leftJoin('cg.tenant as p', 'p.id', 's.posted_by_tenant_id')
      .select([
        's.name',
        's.kind',
        's.pets',
        's.accessibility',
        's.created_at',
        'l.line1',
        'l.city',
        'l.state',
        'l.postal',
        'p.name as partner',
        sql<number | null>`st_y(l.geom::geometry)`.as('lat'),
        sql<number | null>`st_x(l.geom::geometry)`.as('lon'),
      ])
      .where('s.tenant_id', '=', tenantId)
      .where('s.posted_by_tenant_id', 'is not', null)
      // A confidential site's location never leaves its own record.
      .where('s.confidential', '=', false)
      .where('s.status', '<>', 'closed')
      .orderBy('s.created_at')
      .execute();
    return rows.map((r) => {
      const attributes: KnownAttributes = {};
      const ada = (r.accessibility as Record<string, unknown> | null)?.['ada'];
      if (typeof ada === 'boolean') attributes.ada = ada;
      if (r.pets === 'no') attributes.petPolicy = 'none';
      if (r.pets === 'service_animals') attributes.petPolicy = 'service_animals';
      return {
        name: r.name,
        kind: kindFromText(r.name),
        address: { line1: r.line1, city: r.city, state: r.state, postal: r.postal },
        position:
          r.lat !== null && r.lon !== null ? { lat: Number(r.lat), lon: Number(r.lon) } : null,
        attributes,
        sourceLinks: [],
        note: `Posted by ${r.partner ?? 'a partner organization'} as a ${r.kind.replace(/_/g, ' ')} site on ${new Date(r.created_at).toISOString().slice(0, 10)}`,
      } satisfies FoundPlace;
    });
  });
}

/** Records what was found, in one transaction; returns the counts. */
async function record(
  ctx: JobContext,
  tenantId: string,
  runId: string,
  found: { place: FoundPlace; sourceKind: string; sourceId: string | null; aiOutputId?: string }[],
  summary: Summary,
  now: Date,
): Promise<void> {
  await asSystem(ctx.db, tenantId, async (trx) => {
    // Places already in the registry are left out (by the same fingerprint).
    const registered = await trx
      .selectFrom('cg.facility as f')
      .leftJoin('cg.location as l', 'l.id', 'f.location_id')
      .select(['f.name', 'l.postal', 'l.city', 'l.line1', 'l.state'])
      .where('f.tenant_id', '=', tenantId)
      .execute();
    const known = new Set(
      registered.map((f) =>
        fingerprintOf({
          name: f.name,
          kind: 'other',
          address: { line1: f.line1, city: f.city, state: f.state, postal: f.postal },
          position: null,
          attributes: {},
          sourceLinks: [],
        }),
      ),
    );
    // REC-14: open requests for shelter or food during an active event.
    const needs = (
      await trx
        .selectFrom('cg.need as n')
        .innerJoin('cg.event as e', 'e.id', 'n.event_id')
        .leftJoin('cg.report as r', 'r.id', 'n.report_id')
        .innerJoin('cg.location as l', (j) =>
          j.on((eb) => eb('l.id', '=', eb.fn.coalesce('n.location_id', 'r.location_id'))),
        )
        .select([
          sql<number>`st_y(l.geom::geometry)`.as('lat'),
          sql<number>`st_x(l.geom::geometry)`.as('lon'),
        ])
        .where('n.tenant_id', '=', tenantId)
        .where('e.status', '=', 'active')
        .where('n.status', 'in', ['open', 'claimed', 'in_progress'])
        .where('n.category', 'in', ['shelter_tonight', 'food_water'])
        .where('l.geom', 'is not', null)
        .limit(5000)
        .execute()
    ).map((p) => ({ lat: Number(p.lat), lon: Number(p.lon) }));

    for (const { place, sourceKind, sourceId, aiOutputId } of found) {
      const fp = fingerprintOf(place);
      if ((place.change ?? 'new') === 'new' && known.has(fp)) {
        summary.alreadyRegistered++;
        continue;
      }
      const hash = contentHashOf(place);
      const near =
        !!place.position && needs.some((n) => distanceKm(n, place.position!) <= NEAR_NEED_KM);
      const latest = await trx
        .selectFrom('cg.discovery_candidate')
        .select(['id', 'state', 'content_hash', 'source_links', 'decided_at'])
        .where('tenant_id', '=', tenantId)
        .where('fingerprint', '=', fp)
        .orderBy('created_at', 'desc')
        .limit(1)
        .executeTakeFirst();
      if (latest?.state === 'accepted') {
        summary.alreadyRegistered++;
        continue;
      }
      if (latest?.state === 'rejected' && latest.content_hash === hash) {
        await trx
          .updateTable('cg.discovery_candidate')
          .set((eb) => ({ last_seen_at: now, seen_count: eb('seen_count', '+', 1) }))
          .where('id', '=', latest.id)
          .execute();
        summary.rememberedRejected++;
        continue;
      }
      const content = {
        name: place.name,
        kind: place.kind,
        address: place.address ? JSON.stringify(place.address) : null,
        lat: place.position?.lat ?? null,
        lon: place.position?.lon ?? null,
        attributes: JSON.stringify(place.attributes),
        unknown: unknownOf(place.attributes),
        precheck: JSON.stringify(precheck(place)),
        content_hash: hash,
        near_unmet_need: near,
      };
      if (latest?.state === 'pending') {
        const links = [...new Set([...latest.source_links, ...place.sourceLinks])].slice(0, 10);
        await trx
          .updateTable('cg.discovery_candidate')
          .set((eb) => ({
            ...(latest.content_hash !== hash ? content : { near_unmet_need: near }),
            source_links: links,
            last_seen_at: now,
            seen_count: eb('seen_count', '+', 1),
          }))
          .where('id', '=', latest.id)
          .execute();
        summary.refreshed++;
        continue;
      }
      const again =
        latest?.state === 'rejected'
          ? `Set aside on ${latest.decided_at ? new Date(latest.decided_at).toISOString().slice(0, 10) : 'an earlier date'}; found again with changes.`
          : null;
      await trx
        .insertInto('cg.discovery_candidate')
        .values({
          tenant_id: tenantId,
          run_id: runId,
          source_kind: sourceKind as 'hsds',
          source_id: sourceId,
          change: place.change ?? 'new',
          facility_id: place.facilityId ?? null,
          ...content,
          source_links: place.sourceLinks.slice(0, 10),
          note: [again, place.note].filter(Boolean).join(' ') || null,
          fingerprint: fp,
          ai_output_id: aiOutputId ?? null,
        })
        .execute();
      summary.added++;
      if (near) summary.nearUnmetNeed++;
    }
    for (const s of summary.sources)
      await trx
        .updateTable('cg.discovery_source')
        .set({ last_run_at: now, last_outcome: s.outcome })
        .where('id', '=', s.id)
        .execute();
    await trx
      .updateTable('cg.discovery_run')
      .set({ state: 'done', finished_at: now, summary: JSON.stringify(summary) })
      .where('id', '=', runId)
      .execute();
    await systemAudit(trx, tenantId, 'discovery', {
      action: 'discovery.run',
      targetType: 'discovery_run',
      targetId: runId,
      reason: `${summary.added} new, ${summary.refreshed} seen again, ${summary.alreadyRegistered} already registered, ${summary.rememberedRejected} rejected before`,
    });
  });
}

/** Runs discovery for every tenant that asked or is due; returns the candidates added. */
export async function runDiscovery(ctx: JobContext, deps: DiscoveryDeps = {}): Promise<number> {
  const get = deps.get ?? publicGet();
  let added = 0;
  for (const tenantId of deps.tenantIds ?? (await allTenantIds(ctx.db))) {
    const now = nowOf(ctx);
    const runId = await claimRun(ctx, tenantId, now);
    if (!runId) continue;
    const summary: Summary = {
      partnerPosts: 0,
      sources: [],
      added: 0,
      refreshed: 0,
      alreadyRegistered: 0,
      rememberedRejected: 0,
      nearUnmetNeed: 0,
    };
    const found: {
      place: FoundPlace;
      sourceKind: string;
      sourceId: string | null;
      aiOutputId?: string;
    }[] = [];
    try {
      const posts = await partnerPosts(ctx, tenantId);
      summary.partnerPosts = posts.length;
      for (const p of posts) found.push({ place: p, sourceKind: 'partner_post', sourceId: null });
      const sources = (await asSystem(ctx.db, tenantId, (trx) =>
        trx
          .selectFrom('cg.discovery_source')
          .select(['id', 'kind', 'name', 'url'])
          .where('tenant_id', '=', tenantId)
          .where('enabled', '=', true)
          .orderBy('created_at')
          .execute(),
      )) as SourceRow[];
      for (const s of sources) {
        if (s.kind === 'web_search') {
          const r = await webSearch(ctx, tenantId, runId);
          summary.sources.push({
            id: s.id,
            name: s.name,
            outcome: r.outcome,
            places: r.places.length,
          });
          for (const p of r.places)
            found.push({
              place: p,
              sourceKind: 'web_search',
              sourceId: s.id,
              ...(r.aiOutputId ? { aiOutputId: r.aiOutputId } : {}),
            });
          continue;
        }
        if (!s.url) continue;
        const r = await get(s.url);
        if (!r.ok) {
          summary.sources.push({ id: s.id, name: s.name, outcome: r.error, places: 0 });
          continue;
        }
        const places = placesFromFeed(s.kind, r.body, s.url);
        summary.sources.push({
          id: s.id,
          name: s.name,
          outcome: places.length
            ? `Read ${places.length} place${places.length === 1 ? '' : 's'}.`
            : 'Read, but no place could be taken from it: check the format.',
          places: places.length,
        });
        for (const p of places) found.push({ place: p, sourceKind: s.kind, sourceId: s.id });
      }
      await record(ctx, tenantId, runId, found, summary, nowOf(ctx));
      added += summary.added;
    } catch (err) {
      ctx.log.error({ err: (err as Error).name, tenantId, runId }, 'discovery run failed');
      await asSystem(ctx.db, tenantId, (trx) =>
        trx
          .updateTable('cg.discovery_run')
          .set({
            state: 'failed',
            finished_at: nowOf(ctx),
            summary: JSON.stringify({
              ...summary,
              error: 'The run stopped; the next one retries.',
            }),
          })
          .where('id', '=', runId)
          .execute(),
      );
    }
  }
  return added;
}
