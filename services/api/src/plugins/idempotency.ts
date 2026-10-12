/**
 * Idempotent creates (BRD:FR-00.06, AC-00C, AC-11B). Routes opt in with
 * `config: { idempotent: true }`. The client sends `Idempotency-Key: <uuid>`
 * (its execution id). Same key + same request → the stored response is
 * replayed; same key + different request → 422; key still in flight → 409.
 * Rows live in cg.idempotency_key under RLS, scoped to the subject.
 */
import { createHash } from 'node:crypto';
import fp from 'fastify-plugin';
import { sql } from 'kysely';
import { errors } from '../errors.ts';

declare module 'fastify' {
  interface FastifyContextConfig {
    idempotent?: boolean;
  }
  interface FastifyRequest {
    idempotency?: { scope: string; key: string; hash: Buffer; tenantId: string };
  }
}

function requestHash(method: string, url: string, body: unknown): Buffer {
  return createHash('sha256')
    .update(method)
    .update('\n')
    .update(url)
    .update('\n')
    .update(body === undefined ? '' : JSON.stringify(body))
    .digest();
}

export const idempotencyPlugin = fp(
  async (app) => {
    app.addHook('preHandler', async (request, reply) => {
      if (!request.routeOptions.config.idempotent) return;
      const key = request.headers['idempotency-key'];
      if (typeof key !== 'string' || !/^[0-9a-f-]{36}$/i.test(key))
        throw errors.idempotencyKeyRequired();

      const s = request.subject;
      const tenantId = s.tenantId;
      if (!tenantId) throw errors.unauthorized('tenant_required');
      const scope = s.kind === 'account' ? `account:${s.accountId}` : 'public';
      const hash = requestHash(request.method, request.url, request.body);
      request.idempotency = { scope, key, hash, tenantId };

      const existing = await request.tx((trx) =>
        trx
          .selectFrom('cg.idempotency_key')
          .select(['status', 'request_hash', 'response_status', 'response_body'])
          .where('tenant_id', '=', tenantId)
          .where('scope', '=', scope)
          .where('key', '=', key)
          .where('expires_at', '>', new Date())
          .executeTakeFirst(),
      );

      if (existing) {
        if (!existing.request_hash.equals(hash)) throw errors.idempotencyMismatch();
        if (existing.status === 'in_progress') throw errors.inProgress();
        reply.header('Idempotency-Replayed', 'true');
        return reply.code(existing.response_status ?? 200).send(existing.response_body);
      }

      await request.tx((trx) =>
        trx
          .insertInto('cg.idempotency_key')
          .values({
            tenant_id: tenantId,
            scope,
            key,
            request_hash: hash,
            status: 'in_progress',
          })
          // Two identical requests racing: the second sees the first's row.
          .onConflict((oc) => oc.doNothing())
          .execute(),
      );
    });

    app.addHook('onSend', async (request, reply, payload) => {
      const idem = request.idempotency;
      if (!idem || reply.getHeader('Idempotency-Replayed')) return payload;
      const status = reply.statusCode;
      if (status >= 500) {
        // Let the client retry: a server failure must not pin a failed response.
        await request
          .tx((trx) =>
            trx
              .deleteFrom('cg.idempotency_key')
              .where('tenant_id', '=', idem.tenantId)
              .where('scope', '=', idem.scope)
              .where('key', '=', idem.key)
              .execute(),
          )
          .catch(() => undefined);
        return payload;
      }
      const body = typeof payload === 'string' && payload.length > 0 ? payload : 'null';
      await request.tx((trx) =>
        trx
          .updateTable('cg.idempotency_key')
          .set({
            status: 'completed',
            response_status: status,
            response_body: sql`${body}::jsonb`,
          })
          .where('tenant_id', '=', idem.tenantId)
          .where('scope', '=', idem.scope)
          .where('key', '=', idem.key)
          .execute(),
      );
      return payload;
    });
  },
  { name: 'cg-idempotency', dependencies: ['cg-context'] },
);
