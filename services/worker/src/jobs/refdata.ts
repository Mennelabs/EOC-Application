/**
 * Reference data jobs (layer-6 task A; ADR-0039, SCL-09, SCL-06, SCL-12,
 * RULE-10, SEC-13):
 * - `refdata.pull`: run the tenant's connector for one dataset against its
 *   geography and write a snapshot. A source that is down leaves a failed
 *   attempt beside the last good snapshot; the job never throws for that,
 *   so the broker does not hammer a federal service with redeliveries.
 * - `refdata.import`: validate an uploaded file against its column mapping,
 *   or apply a validated one as a snapshot.
 * - schedule: queue a pull for every dataset whose current snapshot is older
 *   than its connector's refresh period (or missing), once per hour at most.
 * - prune: superseded or failed snapshots no issued report cites, older than
 *   the tenant's `reference_data` retention, honouring legal holds.
 * Only geography leaves the system; recorded synthetic responses stand in
 * for the federal services in development and CI.
 */
import { randomUUID } from 'node:crypto';
import { sql, type Transaction } from 'kysely';
import { diffForAudit } from '@cg/audit';
import type { Database } from '@cg/db';
import {
  connectorFor,
  DATASETS,
  parseImport,
  runPull,
  writeSnapshot,
  type Connector,
  type Dataset,
  type EgressHttp,
  type Scope,
} from '@cg/refdata';
import { allTenantIds, asSystem, enqueueOutbox, systemAudit } from '../system.ts';
import type { JobContext, TopicHandler } from './types.ts';

/** How the worker reaches the sources, from configuration (worker main). */
export interface RefdataDeps {
  mode: 'recorded' | 'live' | 'off';
  /** An HTTP client limited to the hosts given (recorded responses in `recorded` mode). */
  http(hosts: readonly string[]): EgressHttp;
  secrets: { censusApiKey?: string };
}

type Trx = Transaction<Database>;

/** Reference data is public; what these audit rows record is internal bookkeeping. */
const internal = () => 'internal' as const;

const isDataset = (v: unknown): v is Dataset =>
  typeof v === 'string' && (DATASETS as readonly string[]).includes(v);

async function configValue(trx: Trx, tenantId: string, key: string): Promise<unknown> {
  const row = await trx
    .selectFrom('cg.tenant_config')
    .select('value')
    .where('tenant_id', '=', tenantId)
    .where('key', '=', key)
    .executeTakeFirst();
  return row?.value;
}

/**
 * The geography a tenant's reference data covers: `refdata.scope` in its
 * configuration when set, else its jurisdiction's FIPS code (a county), its
 * county's (a city), or the counties below it (a state or region). Partner
 * organizations have none.
 */
export async function referenceScope(trx: Trx, tenantId: string): Promise<Scope | null> {
  const configured = (await configValue(trx, tenantId, 'refdata.scope')) as {
    stateFips?: unknown;
    countyFips?: unknown;
  } | null;
  if (
    configured &&
    typeof configured.stateFips === 'string' &&
    /^[0-9]{2}$/.test(configured.stateFips) &&
    Array.isArray(configured.countyFips) &&
    configured.countyFips.length > 0 &&
    configured.countyFips.every((c) => typeof c === 'string' && /^[0-9]{5}$/.test(c))
  )
    return { stateFips: configured.stateFips, countyFips: configured.countyFips as string[] };

  const tenant = await trx
    .selectFrom('cg.tenant')
    .select(['kind', 'parent_id'])
    .where('id', '=', tenantId)
    .executeTakeFirst();
  if (!tenant) return null;
  const fipsOf = async (id: string) =>
    (
      await trx
        .selectFrom('cg.jurisdiction')
        .select('fips')
        .where('tenant_id', '=', id)
        .executeTakeFirst()
    )?.fips ?? null;
  const county = (fips: string | null): Scope | null =>
    fips && /^[0-9]{5}$/.test(fips) ? { stateFips: fips.slice(0, 2), countyFips: [fips] } : null;

  if (tenant.kind === 'county') return county(await fipsOf(tenantId));
  if (tenant.kind === 'city')
    return tenant.parent_id ? county(await fipsOf(tenant.parent_id)) : null;
  if (tenant.kind === 'state' || tenant.kind === 'region') {
    const below = await sql<{ fips: string }>`
      with recursive sub as (
        select id from cg.tenant where parent_id = ${tenantId}
        union all
        select t.id from cg.tenant t join sub on t.parent_id = sub.id
      )
      select distinct j.fips from sub join cg.tenant t on t.id = sub.id
      join cg.jurisdiction j on j.tenant_id = t.id
      where t.kind = 'county' and t.status <> 'closed' and j.fips ~ '^[0-9]{5}$'
      order by j.fips`.execute(trx);
    const counties = below.rows.map((r) => r.fips);
    const own = await fipsOf(tenantId);
    const stateFips = own && /^[0-9]{2}$/.test(own) ? own : counties[0]?.slice(0, 2);
    const inState = counties.filter((c) => c.startsWith(stateFips ?? '--'));
    return stateFips && inState.length ? { stateFips, countyFips: inState } : null;
  }
  return null;
}

/** The connector a tenant pulls a dataset from (`refdata.sources` names one, or `import`). */
async function tenantConnector(
  trx: Trx,
  tenantId: string,
  dataset: Dataset,
): Promise<Connector | 'import' | undefined> {
  const sources = (await configValue(trx, tenantId, 'refdata.sources')) as Record<
    string,
    unknown
  > | null;
  const choice = sources && typeof sources[dataset] === 'string' ? sources[dataset] : null;
  return connectorFor(dataset, choice);
}

export const refdataPull: TopicHandler = async (ctx, msg) => {
  const dataset = msg.payload['dataset'];
  const requestedBy =
    typeof msg.payload['requestedBy'] === 'string' ? msg.payload['requestedBy'] : null;
  const deps = ctx.refdata;
  if (!isDataset(dataset)) return;
  if (!deps || deps.mode === 'off') {
    ctx.log.info({ dataset }, 'reference pulls are off; nothing pulled');
    return;
  }
  const { scope, connector } = await asSystem(ctx.db, msg.tenantId, async (trx) => ({
    scope: await referenceScope(trx, msg.tenantId),
    connector: await tenantConnector(trx, msg.tenantId, dataset),
  }));
  if (!scope || !connector || connector === 'import') {
    ctx.log.info(
      { dataset, scope: Boolean(scope), connector: typeof connector },
      'no geography or no pull source for this tenant; nothing pulled',
    );
    return;
  }
  const result = await runPull(ctx.db, connector, {
    tenantId: msg.tenantId,
    mode: deps.mode === 'live' ? 'pull' : 'recorded',
    http: deps.http(connector.hosts),
    scope,
    secrets: deps.secrets,
    now: () => ctx.now?.() ?? new Date(),
    createdBy: requestedBy,
  });
  if (result.status === 'failed')
    ctx.log.warn({ dataset, source: connector.id, error: result.error }, 'reference pull failed');
  await asSystem(ctx.db, msg.tenantId, (trx) =>
    systemAudit(trx, msg.tenantId, 'refdata.pull', {
      action: 'refdata.pull',
      targetType: 'refdata_snapshot',
      targetId: result.snapshotId,
      executionId: msg.executionId,
      changes: diffForAudit(
        null,
        { dataset, source: connector.id, status: result.status, row_count: result.rowCount },
        internal,
      ),
    }),
  );
};

export const refdataImport: TopicHandler = async (ctx, msg) => {
  const importId = msg.payload['importId'];
  if (typeof importId !== 'string' || !ctx.objects) return;
  const objects = ctx.objects;
  const row = await asSystem(ctx.db, msg.tenantId, (trx) =>
    trx
      .selectFrom('cg.refdata_import')
      .selectAll()
      .where('id', '=', importId)
      .where('tenant_id', '=', msg.tenantId)
      .executeTakeFirst(),
  );
  // A redelivered message after the work was done finds the import already settled.
  if (!row || (row.status !== 'validating' && row.status !== 'applying')) return;
  const apply = row.status === 'applying';
  const file = await objects.get(row.object_key);
  const parsed = parseImport(row.dataset, row.format, file.body.toString('utf8'), row.mapping);

  let status: 'validated' | 'invalid' | 'applied' | 'failed';
  let errors = parsed.errors;
  let snapshotId: string | null = null;
  if (parsed.errors.length) status = 'invalid';
  else if (!apply) status = 'validated';
  else {
    const result = await writeSnapshot(
      ctx.db,
      {
        tenantId: msg.tenantId,
        dataset: row.dataset,
        source: 'import',
        mode: 'import',
        scope: { importId: row.id },
        vintage: row.vintage,
        sourceUrl: null,
        licence: row.licence,
        importId: row.id,
        createdBy: row.updated_by,
      },
      parsed.rows,
    );
    snapshotId = result.snapshotId;
    status = result.status === 'ready' ? 'applied' : 'failed';
    if (result.error) errors = [{ message: result.error }];
  }
  await asSystem(ctx.db, msg.tenantId, async (trx) => {
    await trx
      .updateTable('cg.refdata_import')
      .set({
        status,
        errors: JSON.stringify(errors),
        row_count: parsed.total,
        ...(snapshotId ? { snapshot_id: snapshotId } : {}),
        version: sql`version + 1`,
      })
      .where('id', '=', row.id)
      .execute();
    await systemAudit(
      trx,
      msg.tenantId,
      apply ? 'refdata.import.apply' : 'refdata.import.validate',
      {
        action: apply ? 'refdata.import.apply' : 'refdata.import.validate',
        targetType: 'refdata_import',
        targetId: row.id,
        executionId: msg.executionId,
        changes: diffForAudit(
          { status: row.status },
          { status, row_count: parsed.total, snapshot_id: snapshotId },
          internal,
        ),
      },
    );
  });
};

const HOUR = 3600_000;

/** Every 15 minutes: queue a pull for each dataset that is due (SCL-06: a failed source is retried hourly). */
export async function scheduleReferencePulls(ctx: JobContext): Promise<void> {
  if (!ctx.refdata || ctx.refdata.mode === 'off') return;
  const now = ctx.now?.() ?? new Date();
  for (const tenantId of await allTenantIds(ctx.db)) {
    await asSystem(ctx.db, tenantId, async (trx) => {
      if ((await configValue(trx, tenantId, 'refdata.enabled')) === false) return;
      if (!(await referenceScope(trx, tenantId))) return;
      for (const dataset of DATASETS) {
        const connector = await tenantConnector(trx, tenantId, dataset);
        if (!connector || connector === 'import') continue;
        const latest = await trx
          .selectFrom('cg.refdata_snapshot')
          .select([
            (eb) => eb.fn.max('retrieved_at').as('attempted'),
            sql<Date | null>`max(retrieved_at) filter (where status in ('ready', 'superseded'))`.as(
              'good',
            ),
          ])
          .where('tenant_id', '=', tenantId)
          .where('dataset', '=', dataset)
          .where('mode', '<>', 'import')
          .executeTakeFirst();
        const good = latest?.good ? new Date(latest.good).getTime() : 0;
        const attempted = latest?.attempted ? new Date(latest.attempted).getTime() : 0;
        if (now.getTime() - good < connector.refreshMs) continue;
        if (now.getTime() - attempted < Math.min(connector.refreshMs, HOUR)) continue;
        const queued = await trx
          .selectFrom('cg.outbox')
          .select('id')
          .where('tenant_id', '=', tenantId)
          .where('topic', '=', 'refdata.pull')
          .where('created_at', '>', new Date(now.getTime() - HOUR))
          .where(sql<boolean>`payload->>'dataset' = ${dataset}`)
          .executeTakeFirst();
        if (queued) continue;
        await enqueueOutbox(trx, tenantId, 'refdata.pull', { dataset, reason: 'schedule' });
      }
    });
  }
}

/** Daily (SEC-13, RULE-10): drop old superseded and failed snapshots that no issued report cites. */
export async function pruneReferenceSnapshots(ctx: JobContext): Promise<void> {
  const executionId = randomUUID();
  const now = ctx.now?.() ?? new Date();
  for (const tenantId of await allTenantIds(ctx.db)) {
    await asSystem(ctx.db, tenantId, async (trx) => {
      const keep = await sql<{ days: string | null }>`
        select (extract(epoch from keep_for) / 86400)::text as days from cg.retention_policy
        where tenant_id = ${tenantId} and data_category = 'reference_data' and keep_for is not null`.execute(
        trx,
      );
      const days = Number(keep.rows[0]?.days ?? 90);
      if (!Number.isFinite(days) || days <= 0) return;
      const holds = await trx
        .selectFrom('cg.legal_hold')
        .select('scope')
        .where('tenant_id', '=', tenantId)
        .where('released_at', 'is', null)
        .execute();
      const held = new Set<string>();
      for (const h of holds) {
        const sc = (h.scope ?? {}) as Record<string, unknown>;
        if (sc['dataCategory'] === 'reference_data') return;
        if (sc['targetType'] === 'refdata_snapshot') {
          const id = sc['targetId'];
          if (typeof id !== 'string') return;
          if (/^[0-9a-f-]{36}$/i.test(id)) held.add(id);
        }
      }
      const cutoff = new Date(now.getTime() - days * 86_400_000);
      let q = trx
        .deleteFrom('cg.refdata_snapshot')
        .where('tenant_id', '=', tenantId)
        .where('status', 'in', ['superseded', 'failed'])
        .where('cited', '=', false)
        .where('retrieved_at', '<', cutoff)
        .where(({ not, exists, selectFrom }) =>
          not(
            exists(
              selectFrom('cg.refdata_current as c')
                .select('c.snapshot_id')
                .whereRef('c.snapshot_id', '=', 'cg.refdata_snapshot.id'),
            ),
          ),
        );
      if (held.size) q = q.where('id', 'not in', [...held]);
      const gone = await q.returning(['retrieved_at']).execute();
      if (gone.length === 0) return;
      const times = gone.map((r) => new Date(r.retrieved_at).getTime());
      await trx
        .insertInto('cg.deletion_log')
        .values({
          tenant_id: tenantId,
          data_category: 'reference_data',
          target_type: 'refdata_snapshot',
          deleted_count: gone.length,
          oldest: new Date(Math.min(...times)),
          newest: new Date(Math.max(...times)),
          execution_id: executionId,
        })
        .execute();
      await systemAudit(trx, tenantId, 'retention.sweep', {
        action: 'retention.delete',
        targetType: 'refdata_snapshot',
        targetId: `${gone.length} snapshots`,
        executionId,
      });
    });
  }
}
