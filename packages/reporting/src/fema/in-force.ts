/**
 * The FEMA form mapping in force for a county (DCL:DEC-15): its active
 * version, or the version shipped with the platform. Used by every export.
 */
import type { Transaction } from 'kysely';
import type { Database } from '@cg/db';
import { SHIPPED } from './shipped.ts';
import type { FormKey, Mapping, MappingField } from './vocabulary.ts';

type Trx = Transaction<Database>;

/** The county's active version of a form, or the shipped version 1. */
export async function mappingInForce(
  trx: Trx,
  tenantId: string,
  form: FormKey,
): Promise<Mapping & { status: 'shipped' | 'active' }> {
  const row = await trx
    .selectFrom('cg.fema_form_mapping')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .where('form', '=', form)
    .where('status', '=', 'active')
    .executeTakeFirst();
  if (!row) return { ...SHIPPED[form], status: 'shipped' };
  return {
    form,
    femaFormVersion: row.fema_form_version,
    mappingVersion: row.mapping_version,
    sourceDocument: row.source_document ?? '',
    ...(row.scope ? { scope: row.scope as NonNullable<Mapping['scope']> } : {}),
    fields: row.fields as MappingField[],
    status: 'active',
  };
}
