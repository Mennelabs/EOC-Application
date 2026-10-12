/**
 * Outbox topic handlers. Each is idempotent: a redelivered message finds the
 * work already done and records nothing new (BRD:FR-00.06).
 */
import { roleTemplates } from '@cg/authz';
import { ensureRetentionDefaults, ensureTemplateRoles } from '@cg/provisioning';
import { sql } from 'kysely';
import { allTenantIds, asSystem, systemAudit } from '../system.ts';
import type { JobContext, OutboxMessage, TopicHandler } from './types.ts';

const str = (v: unknown): string => (typeof v === 'string' ? v : String(v ?? ''));

/** tenant.provision: retention defaults, template roles, identity realm, activate. */
export const tenantProvision: TopicHandler = async (ctx, msg) => {
  const tenantId = str(msg.payload['tenantId']);
  const tenant = await ctx.db
    .selectFrom('cg.tenant')
    .select(['id', 'slug', 'name', 'locales', 'status', 'security_contact_email'])
    .where('id', '=', tenantId)
    .executeTakeFirst();
  if (!tenant) throw new Error(`tenant ${tenantId} not found`);
  if (tenant.status !== 'provisioning') return; // already done

  await asSystem(ctx.db, tenantId, async (trx) => {
    await ensureRetentionDefaults(trx, tenantId);
    await ensureTemplateRoles(trx, tenantId);
    await systemAudit(trx, tenantId, 'tenant.provision', {
      action: 'tenant.provision',
      targetType: 'tenant',
      targetId: tenantId,
      changes: {
        fields: [
          { name: 'roles_from_templates', to: roleTemplates.length },
          { name: 'retention_defaults', to: true },
        ],
      },
      executionId: msg.executionId,
    });
  });

  await ctx.idp.ensureRealm({
    slug: tenant.slug,
    tenantId,
    displayName: tenant.name,
    locales: tenant.locales,
    consoleRedirect: `${ctx.urls.gatewayPublic}/console/*`,
    consoleOrigin: ctx.urls.gatewayPublic,
    smtp: {
      host: 'mail',
      port: 1025,
      from: `no-reply@${new URL(ctx.urls.gatewayPublic).hostname}`,
    },
    devDirectGrant: ctx.devDirectGrant,
  });

  await asSystem(ctx.db, tenantId, async (trx) => {
    await trx
      .updateTable('cg.tenant')
      .set({ status: 'active' })
      .where('id', '=', tenantId)
      .where('status', '=', 'provisioning')
      .execute();
    await systemAudit(trx, tenantId, 'tenant.provision', {
      action: 'tenant.activate',
      targetType: 'tenant',
      targetId: tenantId,
      changes: {
        fields: [
          { name: 'status', from: 'provisioning', to: 'active' },
          { name: 'realm', to: tenant.slug },
        ],
      },
      executionId: msg.executionId,
    });
  });
  ctx.log.info({ tenantId, realm: tenant.slug }, 'tenant provisioned');
};

/** account.invited: create the identity-provider user and send the invitation. */
export const accountInvited: TopicHandler = async (ctx, msg) => {
  const accountId = str(msg.payload['accountId']);
  const row = await ctx.db
    .selectFrom('cg.account as a')
    .innerJoin('cg.tenant as t', 't.id', 'a.tenant_id')
    .select([
      'a.id',
      'a.email',
      'a.display_name',
      'a.idp_subject',
      'a.status',
      't.slug',
      't.id as tenant_id',
    ])
    .where('a.id', '=', accountId)
    .executeTakeFirst();
  if (!row) throw new Error(`account ${accountId} not found`);
  if (row.idp_subject) return; // already provisioned
  if (!(await ctx.idp.realmExists(row.slug))) {
    // Provisioning has not created the realm yet: let the broker redeliver.
    await new Promise((r) => setTimeout(r, 2000));
    throw new Error(`realm ${row.slug} not ready for account ${accountId}`);
  }
  const devPassword =
    typeof msg.payload['devPassword'] === 'string' ? msg.payload['devPassword'] : undefined;
  const userId = await ctx.idp.ensureUser(row.slug, {
    email: row.email,
    displayName: row.display_name,
    enabled: row.status !== 'deactivated' && row.status !== 'suspended',
    ...(devPassword ? { devPassword } : {}),
  });
  await asSystem(ctx.db, row.tenant_id, async (trx) => {
    await trx
      .updateTable('cg.account')
      .set({ idp_subject: userId })
      .where('id', '=', row.id)
      .execute();
    await systemAudit(trx, row.tenant_id, 'account.invited', {
      action: 'account.idp_user_created',
      targetType: 'account',
      targetId: row.id,
      executionId: msg.executionId,
    });
  });
  if (!devPassword) {
    await ctx.idp.sendInvitation(row.slug, userId, `${ctx.urls.gatewayPublic}/console/`);
  }
};

/** account.status: mirror suspend/deactivate/activate into the identity provider. */
export const accountStatus: TopicHandler = async (ctx, msg) => {
  const accountId = str(msg.payload['accountId']);
  const row = await ctx.db
    .selectFrom('cg.account as a')
    .innerJoin('cg.tenant as t', 't.id', 'a.tenant_id')
    .select(['a.idp_subject', 'a.status', 't.slug'])
    .where('a.id', '=', accountId)
    .executeTakeFirst();
  if (!row?.idp_subject) return;
  await ctx.idp.setUserEnabled(row.slug, row.idp_subject, row.status === 'active');
};

/** event.participant.add: the participant row belongs to the invited tenant (system insert). */
export const eventParticipantAdd: TopicHandler = async (ctx, msg) => {
  const eventId = str(msg.payload['eventId']);
  const tenantId = str(msg.payload['tenantId']);
  await asSystem(ctx.db, tenantId, async (trx) => {
    await trx
      .insertInto('cg.event_participant')
      .values({
        event_id: eventId,
        tenant_id: tenantId,
        role: str(msg.payload['role'] ?? 'partner'),
        added_by: msg.payload['addedBy'] ? str(msg.payload['addedBy']) : null,
      })
      .onConflict((oc) => oc.doNothing())
      .execute();
    await systemAudit(trx, tenantId, 'event.participant.add', {
      action: 'event.participant.added',
      targetType: 'event',
      targetId: eventId,
      executionId: msg.executionId,
    });
  });
};

/** break_glass.started: tell the tenant security contact (SEC-08). */
export const breakGlassStarted: TopicHandler = async (ctx, msg) => {
  const sessionId = str(msg.payload['sessionId']);
  const row = await ctx.db
    .selectFrom('cg.break_glass_session as b')
    .innerJoin('cg.tenant as t', 't.id', 'b.tenant_id')
    .innerJoin('cg.account as a', 'a.id', 'b.account_id')
    .select([
      'b.id',
      'b.tenant_id',
      'b.expires_at',
      'b.notified_at',
      't.name as tenant_name',
      't.security_contact_email',
      'a.display_name',
    ])
    .where('b.id', '=', sessionId)
    .executeTakeFirst();
  if (!row || row.notified_at) return;
  const to = row.security_contact_email;
  if (to) {
    await ctx.mail.send({
      to,
      subject: `${row.tenant_name}: emergency access started`,
      text:
        `${row.display_name} started a break-glass (emergency read) session.\n` +
        `It ends automatically at ${row.expires_at.toISOString()}.\n` +
        `Every record read during it is in the audit log under session ${row.id}.\n` +
        `If this was not expected, suspend the account in the console now.`,
    });
  } else {
    ctx.log.warn(
      { tenantId: row.tenant_id },
      'break-glass started but tenant has no security contact',
    );
  }
  await asSystem(ctx.db, row.tenant_id, async (trx) => {
    await trx
      .updateTable('cg.break_glass_session')
      .set({ notified_at: new Date(), notified_to: to ?? 'none configured' })
      .where('id', '=', row.id)
      .execute();
    await systemAudit(trx, row.tenant_id, 'break_glass.started', {
      action: 'break_glass.notified',
      targetType: 'break_glass_session',
      targetId: row.id,
      reason: to ? `notified ${to}` : 'no security contact configured',
      executionId: msg.executionId,
    });
  });
};

export const topicHandlers: Record<string, TopicHandler> = {
  'tenant.provision': tenantProvision,
  'account.invited': accountInvited,
  'account.status': accountStatus,
  'event.participant.add': eventParticipantAdd,
  'break_glass.started': breakGlassStarted,
  'event.opened': async () => undefined, // layer 2: publish intake link/keyword to channels
};

// ---- schedules --------------------------------------------------------------

/** Every 15 min: verify each tenant's chain and anchor the head hash (ADR-0012). */
export async function anchorAuditChains(ctx: JobContext): Promise<void> {
  for (const tenantId of await allTenantIds(ctx.db)) {
    await asSystem(ctx.db, tenantId, async (trx) => {
      const { rows } = await sql<{ ok: boolean; checked: string; first_bad_seq: string | null }>`
        select ok, checked, first_bad_seq from cg.audit_verify(${tenantId}::uuid)`.execute(trx);
      const v = rows[0];
      if (!v) return;
      if (!v.ok) {
        ctx.log.error({ tenantId, firstBadSeq: v.first_bad_seq }, 'AUDIT CHAIN BROKEN');
        return; // never anchor a broken chain; the alert is the record
      }
      const head = await trx
        .selectFrom('cg.audit_event')
        .select(['seq', 'hash'])
        .where('tenant_id', '=', tenantId)
        .orderBy('seq', 'desc')
        .limit(1)
        .executeTakeFirst();
      if (!head) return;
      const last = await trx
        .selectFrom('cg.audit_anchor')
        .select('through_seq')
        .where('tenant_id', '=', tenantId)
        .orderBy('through_seq', 'desc')
        .limit(1)
        .executeTakeFirst();
      if (last && Number(last.through_seq) >= Number(head.seq)) return;
      const key = `tenant/${tenantId}/audit-anchors/${String(head.seq).padStart(12, '0')}.json`;
      if (ctx.objects) {
        await ctx.objects.putAnchor(
          key,
          JSON.stringify({
            tenantId,
            throughSeq: Number(head.seq),
            hash: head.hash.toString('hex'),
            anchoredAt: new Date().toISOString(),
          }),
        );
      }
      await trx
        .insertInto('cg.audit_anchor')
        .values({
          tenant_id: tenantId,
          through_seq: Number(head.seq),
          hash: head.hash,
          object_key: ctx.objects ? key : null,
        })
        .execute();
    });
  }
}

/** Every minute: close break-glass sessions past their expiry (SEC-08). */
export async function expireBreakGlass(ctx: JobContext): Promise<void> {
  for (const tenantId of await allTenantIds(ctx.db)) {
    await asSystem(ctx.db, tenantId, async (trx) => {
      const expired = await trx
        .updateTable('cg.break_glass_session')
        .set({ ended_at: new Date() })
        .where('tenant_id', '=', tenantId)
        .where('ended_at', 'is', null)
        .where('expires_at', '<', new Date())
        .returning('id')
        .execute();
      for (const s of expired) {
        await systemAudit(trx, tenantId, 'break_glass.expire', {
          action: 'break_glass.expired',
          targetType: 'break_glass_session',
          targetId: s.id,
        });
      }
    });
  }
}

/**
 * Daily: retention housekeeping (SEC-13). Layer 1 has no resident data yet;
 * what expires here are idempotency keys and relayed outbox rows. Every
 * category sweep lands in cg.deletion_log and the audit log, and legal holds
 * are honoured when record tables arrive in later layers.
 */
export async function retentionSweep(ctx: JobContext): Promise<void> {
  const executionId = crypto.randomUUID();
  for (const tenantId of await allTenantIds(ctx.db)) {
    await asSystem(ctx.db, tenantId, async (trx) => {
      const idem = await trx
        .deleteFrom('cg.idempotency_key')
        .where('tenant_id', '=', tenantId)
        .where('expires_at', '<', new Date())
        .returning('created_at')
        .execute();
      const relayed = await trx
        .deleteFrom('cg.outbox')
        .where('tenant_id', '=', tenantId)
        .where('published_at', 'is not', null)
        .where('published_at', '<', new Date(Date.now() - 7 * 86_400_000))
        .returning('created_at')
        .execute();
      for (const [targetType, rows] of [
        ['idempotency_key', idem],
        ['outbox', relayed],
      ] as const) {
        if (rows.length === 0) continue;
        const times = rows.map((r) => r.created_at.getTime());
        await trx
          .insertInto('cg.deletion_log')
          .values({
            tenant_id: tenantId,
            data_category: 'records',
            target_type: targetType,
            deleted_count: rows.length,
            oldest: new Date(Math.min(...times)),
            newest: new Date(Math.max(...times)),
            execution_id: executionId,
          })
          .execute();
        await systemAudit(trx, tenantId, 'retention.sweep', {
          action: 'retention.delete',
          targetType,
          targetId: `${rows.length} rows`,
          executionId,
        });
      }
    });
  }
}

export function describeMessage(msg: OutboxMessage): string {
  return `${msg.topic}#${msg.id}@${msg.tenantId}`;
}
