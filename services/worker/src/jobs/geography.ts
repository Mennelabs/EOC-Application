/**
 * Location geography (layer-6 task C; DCL:DEC-05, EQ-11, CON-07, RULE-10):
 * every located place gets the census tract it falls in, from the tract
 * snapshot in use for its tenant (or the nearest tenant above it), and the
 * most specific jurisdiction around it (a city inside a county). A location
 * is assigned again when its coordinates change or a new tract snapshot
 * becomes current; the row names the snapshot used, so totals by tract can
 * cite it. Runs in batches so an event with tens of thousands of reports
 * catches up within a few ticks (SCL-03).
 */
import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { allTenantIds, asSystem, systemAudit } from '../system.ts';
import type { JobContext } from './types.ts';

const BATCH = 5000;
const MAX_BATCHES_PER_TICK = 20;

/** Assigns one batch for one tenant; returns how many locations it assigned. */
export async function assignBatch(
  ctx: JobContext,
  tenantId: string,
  batch = BATCH,
): Promise<number> {
  return asSystem(ctx.db, tenantId, async (trx) => {
    const done = await sql<{ location_id: string }>`
      with cur as (
        select c.snapshot_id from cg.tenant me
        join cg.tenant anc on me.path <@ anc.path
        join cg.refdata_current c on c.tenant_id = anc.id and c.dataset = 'tract'
        where me.id = ${tenantId}
        order by nlevel(anc.path) desc
        limit 1
      ),
      todo as (
        select l.id, l.geom from cg.location l
        left join cg.location_geo g on g.location_id = l.id
        where l.tenant_id = ${tenantId} and l.geom is not null
          and (g.location_id is null
            or g.tract_snapshot_id is distinct from (select snapshot_id from cur)
            or g.assigned_at < l.updated_at)
        order by l.id
        limit ${batch}
      )
      insert into cg.location_geo
        (location_id, tenant_id, tract_geoid, tract_snapshot_id, jurisdiction_tenant_id, assigned_at)
      select todo.id, ${tenantId},
        (select t.geoid from cg.ref_tract t
          where t.snapshot_id = (select snapshot_id from cur) and st_intersects(t.geom, todo.geom)
          order by t.geoid limit 1),
        (select snapshot_id from cur),
        (select j.tenant_id from cg.jurisdiction j
          join cg.tenant jt on jt.id = j.tenant_id
          join cg.tenant me on me.id = ${tenantId}
          where j.geom is not null and jt.status <> 'closed'
            and (jt.path <@ me.path or me.path <@ jt.path)
            and st_intersects(j.geom, todo.geom)
          order by nlevel(jt.path) desc limit 1),
        now()
      from todo
      on conflict (location_id) do update set
        tract_geoid = excluded.tract_geoid,
        tract_snapshot_id = excluded.tract_snapshot_id,
        jurisdiction_tenant_id = excluded.jurisdiction_tenant_id,
        assigned_at = excluded.assigned_at
      returning location_id`.execute(trx);
    return done.rows.length;
  });
}

/** Every minute: brings each tenant's location geography up to date. */
export async function assignLocationGeography(ctx: JobContext): Promise<void> {
  const executionId = randomUUID();
  for (const tenantId of await allTenantIds(ctx.db)) {
    let total = 0;
    for (let i = 0; i < MAX_BATCHES_PER_TICK; i++) {
      const n = await assignBatch(ctx, tenantId);
      total += n;
      if (n < BATCH) break;
    }
    if (total > 0)
      await asSystem(ctx.db, tenantId, (trx) =>
        systemAudit(trx, tenantId, 'geography.assign', {
          action: 'location_geo.assign',
          targetType: 'location_geo',
          targetId: `${total} locations`,
          executionId,
        }),
      );
  }
}
