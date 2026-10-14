/**
 * Per-request context for the enclave API (SEC-12, ADM-05):
 *
 *  request.person()          the enclave subject, or 401
 *  request.tx(fn)            fn inside the caller's agency row-security context
 *  request.audit(trx, input) an enclave audit row attributed to the caller
 *  request.authorize(a, r)   the enclave policy; denials audited in their own
 *                            transaction; consequential actions need
 *                            X-Confirm and a reason (RULE-14)
 *  request.expectedVersion() If-Match for optimistic concurrency (FR-00.05)
 *
 * Idempotent creates (`config: { idempotent: true }`, FR-00.06) store the
 * response encrypted under the agency key, so a replay holds no CJI in clear.
 */
import { createHash } from 'node:crypto';
import fp from 'fastify-plugin';
import type { FastifyRequest } from 'fastify';
import type { Kysely, Transaction } from 'kysely';
import { withAgency, type CjisDatabase } from '@cg/cjis-db';
import type { FieldCrypto } from '@cg/crypto';
import { AuthError } from '../auth/token.ts';
import type { RequestSubject, SubjectLoader } from '../auth/subject.ts';
import { recordEnclaveAudit, type EnclaveAuditInput } from '../audit.ts';
import {
  ENCLAVE_ACTIONS,
  decide,
  isEnclaveAction,
  type EnclaveDecision,
  type EnclaveResource,
} from '../policy.ts';
import { errors } from '../errors.ts';

export type AuditCall = Omit<
  EnclaveAuditInput,
  'agencyId' | 'actorKind' | 'actorPersonId' | 'requestId' | 'sourceIp' | 'outcome'
> &
  Partial<Pick<EnclaveAuditInput, 'outcome'>>;

declare module 'fastify' {
  interface FastifyContextConfig {
    idempotent?: boolean;
    requiresVersion?: boolean;
  }
  interface FastifyRequest {
    enclaveSubject: RequestSubject | null;
    person(): RequestSubject;
    tx<T>(fn: (trx: Transaction<CjisDatabase>) => Promise<T>): Promise<T>;
    audit(trx: Transaction<CjisDatabase>, input: AuditCall): Promise<void>;
    authorize(
      action: string,
      resource: EnclaveResource,
      options?: { asNotFound?: boolean },
    ): Promise<EnclaveDecision & { confirmedReason: string | null }>;
    expectedVersion(): number;
    idempotency?: { scope: string; key: string; hash: Buffer; agencyId: string };
  }
}

export function parseIfMatch(header: string | string[] | undefined): number | null {
  if (typeof header !== 'string') return null;
  const m = /^(?:W\/)?"?(\d+)"?$/.exec(header.trim());
  return m?.[1] ? Number(m[1]) : null;
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

export interface ContextOptions {
  db: Kysely<CjisDatabase>;
  subjects: SubjectLoader;
  crypto: FieldCrypto;
}

export const contextPlugin = fp<ContextOptions>(
  async (app, opts) => {
    app.decorateRequest('enclaveSubject', null);

    app.addHook('onRequest', async (request) => {
      const header = request.headers.authorization;
      if (!header) return;
      const [scheme, token] = header.split(' ');
      if (scheme !== 'Bearer' || !token) throw errors.unauthorized('malformed_authorization');
      try {
        request.enclaveSubject = await opts.subjects.fromBearer(token);
      } catch (err) {
        if (err instanceof AuthError) throw errors.unauthorized(err.code);
        throw err;
      }
    });

    app.decorateRequest('person', function (this: FastifyRequest): RequestSubject {
      if (!this.enclaveSubject) throw errors.unauthorized();
      return this.enclaveSubject;
    });

    app.decorateRequest(
      'tx',
      function (
        this: FastifyRequest,
        fn: (trx: Transaction<CjisDatabase>) => Promise<unknown>,
      ): Promise<unknown> {
        const s = this.person();
        return withAgency(opts.db, { agencyId: s.agencyId, personId: s.personId }, fn);
      },
    );

    app.decorateRequest(
      'audit',
      function (
        this: FastifyRequest,
        trx: Transaction<CjisDatabase>,
        input: AuditCall,
      ): Promise<void> {
        const s = this.person();
        return recordEnclaveAudit(trx, {
          ...input,
          outcome: input.outcome ?? 'success',
          agencyId: s.agencyId,
          actorKind: 'person',
          actorPersonId: s.personId,
          requestId: this.id,
          sourceIp: this.ip,
        });
      },
    );

    app.decorateRequest(
      'authorize',
      async function (
        this: FastifyRequest,
        action: string,
        resource: EnclaveResource,
        options: { asNotFound?: boolean } = {},
      ) {
        const s = this.person();
        const decision = decide(s, action, resource);
        if (decision.effect === 'deny') {
          await withAgency(opts.db, { agencyId: s.agencyId, personId: s.personId }, (trx) =>
            recordEnclaveAudit(trx, {
              agencyId: s.agencyId,
              actorKind: 'person',
              actorPersonId: s.personId,
              action: 'authz.deny',
              targetType: resource.type,
              targetId: resource.id ?? '-',
              outcome: 'denied',
              reason: `${action}: ${decision.reason}`,
              requestId: this.id,
              sourceIp: this.ip,
            }),
          ).catch((err: unknown) => this.log.warn({ err: String(err) }, 'could not audit denial'));
          if (decision.reason.startsWith('E2:')) throw errors.notQualified([...s.missing]);
          if (options.asNotFound && !decision.visibleRefusal) throw errors.notFound();
          throw errors.forbidden();
        }
        let confirmedReason: string | null = null;
        if (decision.consequential) {
          const confirmed = this.headers['x-confirm'] === 'true';
          const raw = this.headers['x-reason'];
          confirmedReason =
            typeof raw === 'string' && raw.trim().length >= 3 ? raw.trim().slice(0, 500) : null;
          if (!confirmed || !confirmedReason) {
            const description = isEnclaveAction(action)
              ? ENCLAVE_ACTIONS[action].description
              : action;
            throw errors.confirmationRequired(action, description);
          }
        }
        return { ...decision, confirmedReason };
      },
    );

    app.decorateRequest('expectedVersion', function (this: FastifyRequest) {
      const v = parseIfMatch(this.headers['if-match']);
      if (v === null) throw errors.versionRequired();
      return v;
    });

    app.addHook('preHandler', async (request, reply) => {
      if (request.routeOptions.config.requiresVersion) request.expectedVersion();
      if (!request.routeOptions.config.idempotent) return;
      const key = request.headers['idempotency-key'];
      if (typeof key !== 'string' || !/^[0-9a-f-]{36}$/i.test(key))
        throw errors.idempotencyKeyRequired();
      const s = request.person();
      const scope = `person:${s.personId}`;
      const hash = requestHash(request.method, request.url, request.body);
      request.idempotency = { scope, key, hash, agencyId: s.agencyId };
      const existing = await request.tx((trx) =>
        trx
          .selectFrom('cjis.idempotency_key')
          .select(['status', 'request_hash', 'response_status', 'response_body_enc'])
          .where('scope', '=', scope)
          .where('key', '=', key)
          .where('expires_at', '>', new Date())
          .executeTakeFirst(),
      );
      if (existing) {
        if (!existing.request_hash.equals(hash)) throw errors.idempotencyMismatch();
        if (existing.status === 'in_progress') throw errors.inProgress();
        const body = existing.response_body_enc
          ? await opts.crypto.decrypt(s.agencyId, existing.response_body_enc)
          : 'null';
        reply.header('Idempotency-Replayed', 'true');
        reply.header('content-type', 'application/json; charset=utf-8');
        return reply.code(existing.response_status ?? 200).send(body);
      }
      await request.tx((trx) =>
        trx
          .insertInto('cjis.idempotency_key')
          .values({
            agency_id: s.agencyId,
            scope,
            key,
            request_hash: hash,
            status: 'in_progress',
          })
          .onConflict((oc) => oc.doNothing())
          .execute(),
      );
    });

    app.addHook('onSend', async (request, reply, payload) => {
      const idem = request.idempotency;
      if (!idem || reply.getHeader('Idempotency-Replayed')) return payload;
      const status = reply.statusCode;
      const done = (trx: Transaction<CjisDatabase>) =>
        trx
          .deleteFrom('cjis.idempotency_key')
          .where('scope', '=', idem.scope)
          .where('key', '=', idem.key)
          .execute();
      if (status >= 400) {
        // A failure must not pin its response: the client may retry with the same key.
        await request.tx(done).catch(() => undefined);
        return payload;
      }
      const body = typeof payload === 'string' && payload.length > 0 ? payload : 'null';
      const sealed = await opts.crypto.encrypt(idem.agencyId, body);
      await request.tx((trx) =>
        trx
          .updateTable('cjis.idempotency_key')
          .set({ status: 'completed', response_status: status, response_body_enc: sealed })
          .where('scope', '=', idem.scope)
          .where('key', '=', idem.key)
          .execute(),
      );
      return payload;
    });
  },
  { name: 'cjis-context' },
);
