/**
 * One pull (ADR-0039, SCL-06): run a connector for a tenant's geography and
 * write what it returns as a snapshot. A source that is down, refused by the
 * egress allowlist or missing from the recordings still leaves a `failed`
 * snapshot with a short reason, so staff see when the last attempt failed
 * while screens and reports keep the last good snapshot.
 */
import type { Kysely } from 'kysely';
import { withTenant, type Database } from '@cg/db';
import type { Connector, ConnectorContext } from './connector.ts';
import { redactUrl } from './http.ts';
import { writeSnapshot, type SnapshotResult } from './snapshot.ts';

export interface PullOptions extends ConnectorContext {
  tenantId: string;
  mode: 'pull' | 'recorded';
  createdBy?: string | null;
}

function reasonOf(err: unknown): string {
  const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  return msg.slice(0, 500);
}

export async function runPull(
  db: Kysely<Database>,
  connector: Connector,
  opts: PullOptions,
): Promise<SnapshotResult> {
  const base = {
    tenantId: opts.tenantId,
    dataset: connector.dataset,
    source: connector.id,
    mode: opts.mode,
    scope: { ...opts.scope },
    licence: connector.licence,
    createdBy: opts.createdBy ?? null,
  };
  let fetched;
  try {
    fetched = await connector.fetch(opts);
  } catch (err) {
    const error = reasonOf(err);
    const failed = await withTenant(db, { tenantId: opts.tenantId }, (trx) =>
      trx
        .insertInto('cg.refdata_snapshot')
        .values({
          tenant_id: base.tenantId,
          dataset: base.dataset,
          source: base.source,
          mode: base.mode,
          scope: JSON.stringify(base.scope),
          licence: base.licence,
          status: 'failed',
          error,
          created_by: base.createdBy,
        })
        .returning('id')
        .executeTakeFirstOrThrow(),
    );
    return { snapshotId: failed.id, status: 'failed', rowCount: 0, checksum: null, error };
  }
  return writeSnapshot(
    db,
    { ...base, vintage: fetched.vintage, sourceUrl: redactUrl(fetched.sourceUrl) },
    fetched.rows,
  );
}
