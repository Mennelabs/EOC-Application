/**
 * Command aliases (layer-7 task C; CMD-04, BRD:FR-18.05, FR-00.10, Section
 * 30.2). Anyone with the command window keeps personal aliases for lookups
 * and drafts; the organization's aliases are set only with the explicit
 * `command_alias.manage`, confirmed with a reason. Every change is versioned
 * and audited; a retired alias stays in the table for the history.
 */
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type { Selectable } from 'kysely';
import { z } from 'zod';
import { diffForAudit } from '@cg/audit';
import type { CommandAliasTable } from '@cg/db';
import { checkAlias, type AliasScope } from '../commands/aliases.ts';
import { ApiError, errors } from '../errors.ts';
import { assertUpdated } from '../plugins/versions.ts';
import { classifierFor, iso, stamped, uuidParam } from './helpers.ts';

type Row = Selectable<CommandAliasTable>;

const aliasOut = z.object({
  ...stamped,
  scope: z.enum(['personal', 'organization']),
  name: z.string(),
  expansion: z.string(),
  command: z.string(),
  mine: z.boolean(),
});

const toOut = (r: Row, accountId: string): z.infer<typeof aliasOut> => ({
  id: r.id,
  version: r.version,
  createdAt: iso(r.created_at)!,
  updatedAt: iso(r.updated_at)!,
  scope: r.scope,
  name: r.name,
  expansion: r.expansion,
  command: r.command,
  mine: r.account_id === accountId,
});

export const commandAliasRoutes: FastifyPluginAsync = async (base) => {
  const app = base.withTypeProvider<ZodTypeProvider>();

  const account = (request: FastifyRequest) => {
    const s = request.subject;
    if (s.kind !== 'account') throw errors.unauthorized();
    return s;
  };

  /** Personal: the command window. Organization: the explicit, confirmed management action. */
  const authorizeScope = async (request: FastifyRequest, scope: AliasScope) => {
    const s = account(request);
    await request.authorize(scope === 'organization' ? 'command_alias.manage' : 'command.use', {
      type: scope === 'organization' ? 'command_alias' : 'command',
      tenantId: s.tenantId,
    });
  };

  const check = async (
    request: FastifyRequest,
    scope: AliasScope,
    name: string,
    expansion: string,
  ) => {
    const s = account(request);
    const tz = await request.tx((trx) =>
      trx
        .selectFrom('cg.tenant')
        .select('timezone')
        .where('id', '=', s.tenantId)
        .executeTakeFirst(),
    );
    const r = checkAlias(scope, name, expansion, {
      now: new Date(),
      timeZone: tz?.timezone ?? 'UTC',
    });
    if (!r.ok)
      throw errors.validation([
        {
          name: r.code === 'name' || r.code === 'reserved' ? 'name' : 'expansion',
          message: r.message,
        },
      ]);
    return r.command.name;
  };

  app.get(
    '/command-aliases',
    { schema: { tags: ['commands'], response: { 200: z.array(aliasOut) } } },
    async (request) => {
      const s = account(request);
      await request.authorize('command.use', { type: 'command', tenantId: s.tenantId });
      const rows = await request.tx((trx) =>
        trx
          .selectFrom('cg.command_alias')
          .selectAll()
          .where('retired_at', 'is', null)
          .where((eb) =>
            eb.or([eb('scope', '=', 'organization'), eb('account_id', '=', s.accountId)]),
          )
          .orderBy('scope')
          .orderBy('name')
          .execute(),
      );
      return rows.map((r) => toOut(r, s.accountId));
    },
  );

  app.post(
    '/command-aliases',
    {
      config: { idempotent: true },
      schema: {
        tags: ['commands'],
        body: z.object({
          scope: z.enum(['personal', 'organization']).default('personal'),
          name: z.string().trim().toLowerCase().min(1).max(30),
          expansion: z.string().trim().min(2).max(500),
        }),
        response: { 201: aliasOut },
      },
    },
    async (request, reply) => {
      const s = account(request);
      const b = request.body;
      await authorizeScope(request, b.scope);
      const command = await check(request, b.scope, b.name, b.expansion);
      const { reason } = request.confirmation();
      const row = await request.tx(async (trx) => {
        const taken = await trx
          .selectFrom('cg.command_alias')
          .select('id')
          .where('retired_at', 'is', null)
          .where('scope', '=', b.scope)
          .where('name', '=', b.name)
          .$if(b.scope === 'personal', (q) => q.where('account_id', '=', s.accountId))
          .executeTakeFirst();
        if (taken)
          throw new ApiError(409, 'alias_exists', `"/${b.name}" is already an alias here.`);
        const inserted = await trx
          .insertInto('cg.command_alias')
          .values({
            tenant_id: s.tenantId,
            scope: b.scope,
            account_id: b.scope === 'personal' ? s.accountId : null,
            name: b.name,
            expansion: b.expansion,
            command,
            retired_at: null,
            created_by: s.accountId,
            updated_by: s.accountId,
          })
          .returningAll()
          .executeTakeFirstOrThrow();
        await request.audit(trx, {
          action: 'command_alias.create',
          targetType: 'command_alias',
          targetId: inserted.id,
          targetVersion: inserted.version,
          changes: diffForAudit(
            null,
            { scope: b.scope, name: b.name, expansion: b.expansion },
            classifierFor('command_alias'),
          ),
          reason,
        });
        return inserted;
      });
      return reply.code(201).send(toOut(row, s.accountId));
    },
  );

  const loadEditable = async (request: FastifyRequest, id: string) => {
    const s = account(request);
    const row = await request.tx((trx) =>
      trx
        .selectFrom('cg.command_alias')
        .selectAll()
        .where('id', '=', id)
        .where('retired_at', 'is', null)
        .executeTakeFirst(),
    );
    // Someone else's personal alias does not exist for this person.
    if (!row || (row.scope === 'personal' && row.account_id !== s.accountId))
      throw errors.notFound();
    await authorizeScope(request, row.scope);
    return row;
  };

  app.patch(
    '/command-aliases/:id',
    {
      config: { requiresVersion: true },
      schema: {
        tags: ['commands'],
        params: uuidParam,
        body: z.object({ expansion: z.string().trim().min(2).max(500) }),
        response: { 200: aliasOut },
      },
    },
    async (request) => {
      const s = account(request);
      const row = await loadEditable(request, request.params.id);
      const command = await check(request, row.scope, row.name, request.body.expansion);
      const { reason } = request.confirmation();
      const updated = await request.tx(async (trx) => {
        const u = assertUpdated(
          await trx
            .updateTable('cg.command_alias')
            .set({ expansion: request.body.expansion, command, updated_by: s.accountId })
            .where('id', '=', row.id)
            .where('version', '=', request.expectedVersion())
            .returningAll()
            .executeTakeFirst(),
          toOut(row, s.accountId),
        );
        await request.audit(trx, {
          action: 'command_alias.update',
          targetType: 'command_alias',
          targetId: u.id,
          targetVersion: u.version,
          changes: diffForAudit(
            { expansion: row.expansion },
            { expansion: u.expansion },
            classifierFor('command_alias'),
          ),
          reason,
        });
        return u;
      });
      return toOut(updated, s.accountId);
    },
  );

  app.delete(
    '/command-aliases/:id',
    {
      config: { requiresVersion: true },
      schema: { tags: ['commands'], params: uuidParam, response: { 200: aliasOut } },
    },
    async (request) => {
      const s = account(request);
      const row = await loadEditable(request, request.params.id);
      const { reason } = request.confirmation();
      const retired = await request.tx(async (trx) => {
        const u = assertUpdated(
          await trx
            .updateTable('cg.command_alias')
            .set({ retired_at: new Date(), updated_by: s.accountId })
            .where('id', '=', row.id)
            .where('version', '=', request.expectedVersion())
            .returningAll()
            .executeTakeFirst(),
          toOut(row, s.accountId),
        );
        await request.audit(trx, {
          action: 'command_alias.retire',
          targetType: 'command_alias',
          targetId: u.id,
          targetVersion: u.version,
          reason,
        });
        return u;
      });
      return toOut(retired, s.accountId);
    },
  );
};
