/**
 * Enclave accounts, personnel screening and roles (SEC-12, ADM-05,
 * layer-5 plan §4). An agency administrator creates an account and records
 * the fingerprint-check and training dates (status and dates only); role
 * grants are requests a second administrator decides; activation creates the
 * identity with a one-time temporary password shown once, to be handed over
 * in person (the enclave sends no email). Nobody administers their own
 * account or decides their own request (policy E5). Suspension and
 * deactivation take effect on the next request and close the identity.
 */
import { randomBytes } from 'node:crypto';
import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type { Transaction } from 'kysely';
import { z } from 'zod';
import { ENCLAVE_ROLES, type CjisDatabase, type EnclaveRole } from '@cg/cjis-db';
import { qualification } from '../policy.ts';
import { errors, ApiError } from '../errors.ts';

type Trx = Transaction<CjisDatabase>;

const role = z.enum(ENCLAVE_ROLES as [EnclaveRole, ...EnclaveRole[]]);
const idParams = z.object({ id: z.uuid() });
const day = 24 * 3600 * 1000;

/** A temporary password the realm accepts (15+ characters), handed over in person. */
export function temporaryPassword(): string {
  return `Tmp-${randomBytes(15).toString('base64url')}`;
}

async function present(trx: Trx, id: string) {
  const p = await trx.selectFrom('cjis.person').selectAll().where('id', '=', id).executeTakeFirst();
  if (!p) throw errors.notFound();
  const agency = await trx
    .selectFrom('cjis.agency')
    .select('status')
    .where('id', '=', p.agency_id)
    .executeTakeFirstOrThrow();
  const roles = (
    await trx
      .selectFrom('cjis.role_grant')
      .select('role')
      .where('person_id', '=', id)
      .where('status', '=', 'active')
      .execute()
  ).map((r) => r.role);
  const q = qualification({
    status: p.status,
    agencyStatus: agency.status,
    fingerprintStatus: p.fingerprint_status,
    fingerprintAdjudicatedOn: p.fingerprint_adjudicated_on,
    trainingExpiresOn: p.training_expires_on,
    roles,
  });
  const date = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);
  return {
    id: p.id,
    email: p.email,
    displayName: p.display_name,
    status: p.status,
    statusReason: p.status_reason,
    fingerprintStatus: p.fingerprint_status,
    fingerprintAdjudicatedOn: date(p.fingerprint_adjudicated_on),
    trainingCompletedOn: date(p.training_completed_on),
    trainingExpiresOn: date(p.training_expires_on),
    identityState: p.identity_state,
    lastSeenAt: p.last_seen_at?.toISOString() ?? null,
    roles,
    qualified: q.qualified,
    missing: q.missing,
    version: p.version,
  };
}

export const accountRoutes: FastifyPluginAsync = async (appBase) => {
  const app = appBase.withTypeProvider<ZodTypeProvider>();
  const sealer = appBase.sealer;

  app.get('/me', async (request) => {
    const s = request.person();
    await request.authorize('me.read', { type: 'person', id: s.personId, agencyId: s.agencyId });
    return {
      personId: s.personId,
      agencyId: s.agencyId,
      agencyName: s.agencyName,
      email: s.email,
      displayName: s.displayName,
      status: s.status,
      roles: s.roles,
      qualified: s.qualified,
      missing: s.missing,
      methods: s.methods,
    };
  });

  app.get('/accounts', async (request) => {
    const s = request.person();
    await request.authorize('account.read', { type: 'person', agencyId: s.agencyId });
    return request.tx(async (trx) => {
      const ids = await trx
        .selectFrom('cjis.person')
        .select('id')
        .orderBy('display_name')
        .execute();
      const out = [];
      for (const { id } of ids) out.push(await present(trx, id));
      return out;
    });
  });

  app.get('/accounts/:id', { schema: { params: idParams } }, async (request) => {
    const s = request.person();
    await request.authorize(
      'account.read',
      { type: 'person', id: request.params.id, agencyId: s.agencyId },
      { asNotFound: true },
    );
    return request.tx((trx) => present(trx, request.params.id));
  });

  app.post(
    '/accounts',
    {
      schema: {
        body: z.object({
          email: z.email().max(200),
          displayName: z.string().trim().min(2).max(120),
        }),
      },
      config: { idempotent: true },
    },
    async (request, reply) => {
      const s = request.person();
      await request.authorize('account.create', { type: 'person', agencyId: s.agencyId });
      return request.tx(async (trx) => {
        const taken = await trx
          .selectFrom('cjis.person')
          .select('id')
          .where((eb) => eb(eb.fn('lower', ['email']), '=', request.body.email.toLowerCase()))
          .executeTakeFirst();
        if (taken) throw new ApiError(409, 'account_exists', 'An enclave account has this email.');
        let row;
        try {
          row = await trx
            .insertInto('cjis.person')
            .values({
              agency_id: s.agencyId,
              email: request.body.email,
              display_name: request.body.displayName,
              created_by: s.personId,
              updated_by: s.personId,
            })
            .returning('id')
            .executeTakeFirstOrThrow();
        } catch (err) {
          // Another agency holds the email (row security hides it from this one).
          if ((err as { code?: string }).code === '23505')
            throw new ApiError(409, 'account_exists', 'An enclave account has this email.');
          throw err;
        }
        await request.audit(trx, {
          action: 'account.create',
          targetType: 'person',
          targetId: row.id,
          fields: ['email', 'display_name'],
        });
        return reply.code(201).send(await present(trx, row.id));
      });
    },
  );

  app.post(
    '/accounts/:id/screening',
    {
      schema: {
        params: idParams,
        body: z.object({
          fingerprintStatus: z.enum(['not_started', 'pending', 'cleared', 'denied']).optional(),
          fingerprintAdjudicatedOn: z.iso.date().nullable().optional(),
          trainingCompletedOn: z.iso.date().nullable().optional(),
        }),
      },
      config: { requiresVersion: true },
    },
    async (request) => {
      const s = request.person();
      await request.authorize(
        'account.screening',
        {
          type: 'person',
          id: request.params.id,
          agencyId: s.agencyId,
          aboutPersonId: request.params.id,
        },
        { asNotFound: true },
      );
      const b = request.body;
      const today = new Date().toISOString().slice(0, 10);
      for (const [name, v] of [
        ['fingerprintAdjudicatedOn', b.fingerprintAdjudicatedOn],
        ['trainingCompletedOn', b.trainingCompletedOn],
      ] as const) {
        if (v && v > today) throw errors.validation([{ name, message: 'a date in the future' }]);
      }
      if (b.fingerprintStatus === 'cleared' && !b.fingerprintAdjudicatedOn)
        throw errors.validation([
          {
            name: 'fingerprintAdjudicatedOn',
            message: 'a cleared check needs its adjudication date',
          },
        ]);
      const expected = request.expectedVersion();
      return request.tx(async (trx) => {
        const set: Record<string, unknown> = { updated_by: s.personId };
        if (b.fingerprintStatus !== undefined) {
          set['fingerprint_status'] = b.fingerprintStatus;
          set['fingerprint_adjudicated_on'] =
            b.fingerprintStatus === 'cleared' || b.fingerprintStatus === 'denied'
              ? (b.fingerprintAdjudicatedOn ?? null)
              : null;
          set['fingerprint_recorded_by'] = s.personId;
        }
        if (b.trainingCompletedOn !== undefined) {
          set['training_completed_on'] = b.trainingCompletedOn;
          // AT-2: training counts for twelve months from completion.
          set['training_expires_on'] = b.trainingCompletedOn
            ? new Date(new Date(b.trainingCompletedOn).getTime() + 365 * day)
                .toISOString()
                .slice(0, 10)
            : null;
          set['training_recorded_by'] = s.personId;
        }
        const updated = await trx
          .updateTable('cjis.person')
          .set(set)
          .where('id', '=', request.params.id)
          .where('version', '=', expected)
          .returning('id')
          .executeTakeFirst();
        if (!updated) throw errors.conflict(await present(trx, request.params.id));
        await request.audit(trx, {
          action: 'account.screening',
          targetType: 'person',
          targetId: request.params.id,
          fields: Object.keys(b),
        });
        return present(trx, request.params.id);
      });
    },
  );

  app.post(
    '/accounts/:id/activate',
    { schema: { params: idParams }, config: { requiresVersion: true } },
    async (request) => {
      const s = request.person();
      const d = await request.authorize(
        'account.activate',
        {
          type: 'person',
          id: request.params.id,
          agencyId: s.agencyId,
          aboutPersonId: request.params.id,
        },
        { asNotFound: true },
      );
      const expected = request.expectedVersion();
      return request.tx(async (trx) => {
        const current = await present(trx, request.params.id);
        if (current.status !== 'invited')
          throw new ApiError(409, 'not_invited', 'Only a new account can be activated.');
        // Activation needs everything but the active status itself (plan §4).
        const blocking = current.missing.filter((m) => m !== 'account_not_active');
        if (blocking.length > 0)
          throw new ApiError(
            409,
            'not_ready',
            'Screening, training and an approved role come first.',
            {
              details: { missing: blocking },
            },
          );
        const password = temporaryPassword();
        const updated = await trx
          .updateTable('cjis.person')
          .set({ status: 'active', identity_state: 'pending', updated_by: s.personId })
          .where('id', '=', request.params.id)
          .where('version', '=', expected)
          .returning('id')
          .executeTakeFirst();
        if (!updated) throw errors.conflict(current);
        await trx
          .insertInto('cjis.identity_outbox')
          .values({
            agency_id: s.agencyId,
            person_id: request.params.id,
            kind: 'create_user',
            payload_enc: await sealer.sealJson(s.agencyId, {
              email: current.email,
              displayName: current.displayName,
              temporaryPassword: password,
            }),
          })
          .execute();
        await request.audit(trx, {
          action: 'account.activate',
          targetType: 'person',
          targetId: request.params.id,
          reason: d.confirmedReason,
        });
        return {
          account: await present(trx, request.params.id),
          // Shown once; hand it to the person in person. It is never shown again.
          temporaryPassword: password,
        };
      });
    },
  );

  for (const [path, action, to] of [
    ['suspend', 'account.suspend', 'suspended'],
    ['reactivate', 'account.reactivate', 'active'],
    ['deactivate', 'account.deactivate', 'deactivated'],
  ] as const) {
    app.post(
      `/accounts/:id/${path}`,
      { schema: { params: idParams }, config: { requiresVersion: true } },
      async (request) => {
        const s = request.person();
        const d = await request.authorize(
          action,
          {
            type: 'person',
            id: request.params.id,
            agencyId: s.agencyId,
            aboutPersonId: request.params.id,
          },
          { asNotFound: true },
        );
        const expected = request.expectedVersion();
        return request.tx(async (trx) => {
          const current = await present(trx, request.params.id);
          const allowedFrom: Record<string, string[]> = {
            suspended: ['active'],
            active: ['suspended'],
            deactivated: ['invited', 'active', 'suspended'],
          };
          if (!allowedFrom[to]?.includes(current.status))
            throw new ApiError(409, 'invalid_transition', `The account is ${current.status}.`);
          const updated = await trx
            .updateTable('cjis.person')
            .set({ status: to, status_reason: d.confirmedReason, updated_by: s.personId })
            .where('id', '=', request.params.id)
            .where('version', '=', expected)
            .returning(['id', 'identity_state'])
            .executeTakeFirst();
          if (!updated) throw errors.conflict(current);
          if (to === 'deactivated') {
            await trx
              .updateTable('cjis.role_grant')
              .set({ status: 'revoked', revoked_at: new Date(), revoked_by: s.personId })
              .where('person_id', '=', request.params.id)
              .where('status', '=', 'active')
              .execute();
          }
          if (updated.identity_state === 'created') {
            await trx
              .insertInto('cjis.identity_outbox')
              .values({
                agency_id: s.agencyId,
                person_id: request.params.id,
                kind: to === 'active' ? 'enable_user' : 'disable_user',
              })
              .execute();
          }
          await request.audit(trx, {
            action,
            targetType: 'person',
            targetId: request.params.id,
            reason: d.confirmedReason,
          });
          return present(trx, request.params.id);
        });
      },
    );
  }

  // --- Role requests: a second administrator decides (ADM-05) ---

  const presentRequest = (r: {
    id: string;
    person_id: string;
    role: string;
    change: string;
    status: string;
    reason: string;
    requested_by: string;
    requested_at: Date;
    decided_by: string | null;
    decided_at: Date | null;
    decision_reason: string | null;
    version: number;
  }) => ({
    id: r.id,
    personId: r.person_id,
    role: r.role,
    change: r.change,
    status: r.status,
    reason: r.reason,
    requestedBy: r.requested_by,
    requestedAt: r.requested_at.toISOString(),
    decidedBy: r.decided_by,
    decidedAt: r.decided_at?.toISOString() ?? null,
    decisionReason: r.decision_reason,
    version: r.version,
  });

  app.get(
    '/permission-requests',
    {
      schema: {
        querystring: z.object({
          status: z.enum(['pending', 'approved', 'rejected', 'withdrawn']).optional(),
        }),
      },
    },
    async (request) => {
      const s = request.person();
      await request.authorize('permission.read', {
        type: 'permission_request',
        agencyId: s.agencyId,
      });
      return request.tx(async (trx) => {
        let q = trx
          .selectFrom('cjis.permission_request')
          .selectAll()
          .orderBy('requested_at', 'desc');
        if (request.query.status) q = q.where('status', '=', request.query.status);
        return (await q.limit(200).execute()).map(presentRequest);
      });
    },
  );

  app.post(
    '/permission-requests',
    {
      schema: {
        body: z.object({
          personId: z.uuid(),
          role,
          change: z.enum(['grant', 'revoke']),
          reason: z.string().trim().min(3).max(500),
        }),
      },
      config: { idempotent: true },
    },
    async (request, reply) => {
      const s = request.person();
      await request.authorize('permission.request', {
        type: 'permission_request',
        agencyId: s.agencyId,
        aboutPersonId: request.body.personId,
      });
      const b = request.body;
      return request.tx(async (trx) => {
        const person = await trx
          .selectFrom('cjis.person')
          .select(['id', 'status'])
          .where('id', '=', b.personId)
          .executeTakeFirst();
        if (!person)
          throw errors.validation([{ name: 'personId', message: 'not an account here' }]);
        if (person.status === 'deactivated')
          throw new ApiError(409, 'account_deactivated', 'The account is deactivated.');
        const active = await trx
          .selectFrom('cjis.role_grant')
          .select('id')
          .where('person_id', '=', b.personId)
          .where('role', '=', b.role)
          .where('status', '=', 'active')
          .executeTakeFirst();
        if (b.change === 'grant' && active)
          throw new ApiError(409, 'role_held', 'The account already holds this role.');
        if (b.change === 'revoke' && !active)
          throw new ApiError(409, 'role_not_held', 'The account does not hold this role.');
        const row = await trx
          .insertInto('cjis.permission_request')
          .values({
            agency_id: s.agencyId,
            person_id: b.personId,
            role: b.role,
            change: b.change,
            reason: b.reason,
            requested_by: s.personId,
          })
          .returningAll()
          .executeTakeFirstOrThrow();
        await request.audit(trx, {
          action: 'permission.request',
          targetType: 'permission_request',
          targetId: row.id,
          reason: `${b.change} ${b.role} for ${b.personId}`,
        });
        return reply.code(201).send(presentRequest(row));
      });
    },
  );

  for (const outcome of ['approve', 'reject'] as const) {
    app.post(
      `/permission-requests/:id/${outcome}`,
      { schema: { params: idParams }, config: { requiresVersion: true } },
      async (request) => {
        const s = request.person();
        const target = await request.tx((trx) =>
          trx
            .selectFrom('cjis.permission_request')
            .select(['requested_by', 'person_id'])
            .where('id', '=', request.params.id)
            .executeTakeFirst(),
        );
        if (!target) throw errors.notFound();
        const d = await request.authorize(
          'permission.decide',
          {
            type: 'permission_request',
            id: request.params.id,
            agencyId: s.agencyId,
            requestedBy: target.requested_by,
            aboutPersonId: target.person_id,
          },
          { asNotFound: true },
        );
        const expected = request.expectedVersion();
        return request.tx(async (trx) => {
          const updated = await trx
            .updateTable('cjis.permission_request')
            .set({
              status: outcome === 'approve' ? 'approved' : 'rejected',
              decided_by: s.personId,
              decided_at: new Date(),
              decision_reason: d.confirmedReason,
            })
            .where('id', '=', request.params.id)
            .where('status', '=', 'pending')
            .where('version', '=', expected)
            .returningAll()
            .executeTakeFirst();
          if (!updated) {
            const now = await trx
              .selectFrom('cjis.permission_request')
              .selectAll()
              .where('id', '=', request.params.id)
              .executeTakeFirstOrThrow();
            throw errors.conflict(presentRequest(now));
          }
          if (outcome === 'approve') {
            if (updated.change === 'grant') {
              await trx
                .insertInto('cjis.role_grant')
                .values({
                  agency_id: s.agencyId,
                  person_id: updated.person_id,
                  role: updated.role,
                  request_id: updated.id,
                  granted_by: s.personId,
                })
                .onConflict((oc) =>
                  oc.columns(['person_id', 'role']).where('status', '=', 'active').doNothing(),
                )
                .execute();
            } else {
              await trx
                .updateTable('cjis.role_grant')
                .set({
                  status: 'revoked',
                  revoked_at: new Date(),
                  revoked_by: s.personId,
                  revoke_request_id: updated.id,
                })
                .where('person_id', '=', updated.person_id)
                .where('role', '=', updated.role)
                .where('status', '=', 'active')
                .execute();
            }
          }
          await request.audit(trx, {
            action: `permission.${outcome}`,
            targetType: 'permission_request',
            targetId: updated.id,
            reason: `${updated.change} ${updated.role} for ${updated.person_id}: ${d.confirmedReason ?? ''}`,
          });
          return presentRequest(updated);
        });
      },
    );
  }

  app.post(
    '/permission-requests/:id/withdraw',
    { schema: { params: idParams }, config: { requiresVersion: true } },
    async (request) => {
      const s = request.person();
      await request.authorize('permission.request', {
        type: 'permission_request',
        id: request.params.id,
        agencyId: s.agencyId,
      });
      const expected = request.expectedVersion();
      return request.tx(async (trx) => {
        // Only the requester withdraws, and only while it is pending.
        const updated = await trx
          .updateTable('cjis.permission_request')
          .set({ status: 'withdrawn', decided_at: new Date() })
          .where('id', '=', request.params.id)
          .where('requested_by', '=', s.personId)
          .where('status', '=', 'pending')
          .where('version', '=', expected)
          .returningAll()
          .executeTakeFirst();
        if (!updated) throw errors.notFound();
        await request.audit(trx, {
          action: 'permission.withdraw',
          targetType: 'permission_request',
          targetId: updated.id,
        });
        return presentRequest(updated);
      });
    },
  );
};
