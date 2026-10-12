/**
 * Staff accounts (BRD:FR-01.01–01.05, SEC-07, ACCT-01). Accounts are
 * deactivated, never deleted (AC-01C). Identity-provider work (creating the
 * user in the tenant realm, sending the invitation) happens in the worker
 * through the outbox, so the API never blocks on Keycloak.
 */
import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { diffForAudit } from '@cg/audit';
import type { AccountStatus } from '@cg/db';
import { errors } from '../errors.ts';
import { assertUpdated } from '../plugins/versions.ts';
import { classifierFor, enqueueOutbox, iso, listQuery, stamped, uuidParam } from './helpers.ts';

const accountOut = z.object({
  ...stamped,
  tenantId: z.uuid(),
  email: z.string(),
  displayName: z.string(),
  status: z.enum(['invited', 'active', 'suspended', 'deactivated']),
  invitedAt: z.iso.datetime(),
  activatedAt: z.iso.datetime().nullable(),
  lastLoginAt: z.iso.datetime().nullable(),
});

type AccountRow = {
  id: string;
  version: number;
  created_at: Date;
  updated_at: Date;
  tenant_id: string;
  email: string;
  display_name: string;
  status: AccountStatus;
  invited_at: Date;
  activated_at: Date | null;
  last_login_at: Date | null;
};

const toAccount = (r: AccountRow): z.infer<typeof accountOut> => ({
  id: r.id,
  version: r.version,
  createdAt: iso(r.created_at)!,
  updatedAt: iso(r.updated_at)!,
  tenantId: r.tenant_id,
  email: r.email,
  displayName: r.display_name,
  status: r.status,
  invitedAt: iso(r.invited_at)!,
  activatedAt: iso(r.activated_at),
  lastLoginAt: iso(r.last_login_at),
});

/** Allowed lifecycle transitions (BRD:FR-01.02). */
const transitions: Record<
  'activate' | 'suspend' | 'deactivate',
  { from: AccountStatus[]; to: AccountStatus; action: string }
> = {
  activate: { from: ['invited', 'suspended'], to: 'active', action: 'account.activate' },
  suspend: { from: ['active'], to: 'suspended', action: 'account.suspend' },
  deactivate: {
    from: ['invited', 'active', 'suspended'],
    to: 'deactivated',
    action: 'account.deactivate',
  },
};

export const accountRoutes: FastifyPluginAsync = async (raw) => {
  const app = raw.withTypeProvider<ZodTypeProvider>();

  app.get(
    '/accounts',
    {
      schema: {
        tags: ['accounts'],
        querystring: listQuery,
        response: { 200: z.array(accountOut) },
      },
    },
    async (request) => {
      const s = request.subject;
      if (s.kind !== 'account') throw errors.unauthorized();
      await request.authorize('account.read', { type: 'account', tenantId: s.tenantId });
      const rows = await request.tx((trx) =>
        trx
          .selectFrom('cg.account')
          .selectAll()
          .orderBy('display_name')
          .limit(request.query.limit)
          .offset(request.query.offset)
          .execute(),
      );
      return rows.map(toAccount);
    },
  );

  app.get(
    '/accounts/:id',
    { schema: { tags: ['accounts'], params: uuidParam, response: { 200: accountOut } } },
    async (request) => {
      const row = await request.tx((trx) =>
        trx
          .selectFrom('cg.account')
          .selectAll()
          .where('id', '=', request.params.id)
          .executeTakeFirst(),
      );
      if (!row) throw errors.notFound();
      await request.authorize(
        'account.read',
        { type: 'account', id: row.id, tenantId: row.tenant_id },
        { asNotFound: true },
      );
      return toAccount(row);
    },
  );

  app.post(
    '/accounts/invite',
    {
      config: { idempotent: true },
      schema: {
        tags: ['accounts'],
        body: z.object({ email: z.email(), displayName: z.string().min(1).max(200) }),
        response: { 201: accountOut },
      },
    },
    async (request, reply) => {
      const s = request.subject;
      if (s.kind !== 'account') throw errors.unauthorized();
      await request.authorize('account.invite', { type: 'account', tenantId: s.tenantId });
      const row = await request.tx(async (trx) => {
        const inserted = await trx
          .insertInto('cg.account')
          .values({
            tenant_id: s.tenantId,
            email: request.body.email.toLowerCase(),
            display_name: request.body.displayName,
            created_by: s.accountId,
            updated_by: s.accountId,
          })
          .returningAll()
          .executeTakeFirstOrThrow();
        await trx
          .insertInto('cg.account_lifecycle')
          .values({
            tenant_id: s.tenantId,
            account_id: inserted.id,
            from_status: null,
            to_status: 'invited',
            actor_account_id: s.accountId,
          })
          .execute();
        await request.audit(trx, {
          action: 'account.invite',
          targetType: 'account',
          targetId: inserted.id,
          targetVersion: inserted.version,
          changes: diffForAudit(
            null,
            { email: inserted.email, display_name: inserted.display_name },
            classifierFor('account'),
          ),
        });
        await enqueueOutbox(
          trx,
          s.tenantId,
          'account.invited',
          { accountId: inserted.id },
          request.executionId,
        );
        return inserted;
      });
      return reply.code(201).send(toAccount(row));
    },
  );

  for (const [name, t] of Object.entries(transitions) as [
    keyof typeof transitions,
    (typeof transitions)[keyof typeof transitions],
  ][]) {
    app.post(
      `/accounts/:id/${name}`,
      {
        config: { requiresVersion: true },
        schema: {
          tags: ['accounts'],
          params: uuidParam,
          body: z.object({ reason: z.string().max(500).optional() }).optional(),
          response: { 200: accountOut },
        },
      },
      async (request) => {
        const s = request.subject;
        if (s.kind !== 'account') throw errors.unauthorized();
        const expected = request.expectedVersion();
        const current = await request.tx((trx) =>
          trx
            .selectFrom('cg.account')
            .selectAll()
            .where('id', '=', request.params.id)
            .executeTakeFirst(),
        );
        if (!current) throw errors.notFound();
        await request.authorize(
          t.action,
          { type: 'account', id: current.id, tenantId: current.tenant_id },
          { asNotFound: true },
        );
        // Nobody suspends or deactivates themselves by accident.
        if (current.id === s.accountId && t.to !== 'active')
          throw errors.conflict(toAccount(current));
        if (!t.from.includes(current.status)) throw errors.conflict(toAccount(current));
        const reason = request.confirmation().reason ?? request.body?.reason ?? null;
        const now = new Date();
        const stamp =
          t.to === 'active'
            ? { activated_at: now, suspended_at: null }
            : t.to === 'suspended'
              ? { suspended_at: now }
              : { deactivated_at: now };
        const updated = await request.tx(async (trx) => {
          const row = assertUpdated(
            await trx
              .updateTable('cg.account')
              .set({ status: t.to, ...stamp, updated_by: s.accountId })
              .where('id', '=', current.id)
              .where('version', '=', expected)
              .returningAll()
              .executeTakeFirst(),
            toAccount(current),
          );
          await trx
            .insertInto('cg.account_lifecycle')
            .values({
              tenant_id: s.tenantId,
              account_id: row.id,
              from_status: current.status,
              to_status: t.to,
              reason,
              actor_account_id: s.accountId,
            })
            .execute();
          await request.audit(trx, {
            action: t.action,
            targetType: 'account',
            targetId: row.id,
            targetVersion: row.version,
            changes: diffForAudit(
              { status: current.status },
              { status: row.status },
              classifierFor('account'),
            ),
            reason,
          });
          // The identity provider is told to match (disable/enable the user).
          await enqueueOutbox(
            trx,
            s.tenantId,
            'account.status',
            { accountId: row.id, status: row.status },
            request.executionId,
          );
          return row;
        });
        return toAccount(updated);
      },
    );
  }
};
