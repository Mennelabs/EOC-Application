/**
 * Per-request context: subject, tenant transaction, audit writer.
 *
 *  request.subject      AccountSubject | PublicSubject (never undefined after onRequest)
 *  request.tx(fn)       runs fn inside a transaction with the subject's RLS settings
 *  request.audit(trx)   writes an audit row attributed to the subject (SEC-18)
 */
import fp from 'fastify-plugin';
import type { FastifyRequest } from 'fastify';
import type { Kysely, Transaction } from 'kysely';
import { withTenant, type Database } from '@cg/db';
import { recordAudit, type AuditInput, type AuditReceipt } from '@cg/audit';
import type { AccountSubject, PublicSubject } from '@cg/authz';
import { AuthError, type SubjectLoader } from '../auth/subject.ts';
import { errors } from '../errors.ts';

export type RequestSubject = AccountSubject | PublicSubject;

export type AuditCall = Omit<
  AuditInput,
  'tenantId' | 'actorKind' | 'actorAccountId' | 'requestId'
> &
  Partial<Pick<AuditInput, 'tenantId'>>;

declare module 'fastify' {
  interface FastifyRequest {
    subject: RequestSubject;
    tx<T>(fn: (trx: Transaction<Database>) => Promise<T>): Promise<T>;
    audit(trx: Transaction<Database>, input: AuditCall): Promise<AuditReceipt>;
    executionId: string | null;
  }
}

export interface ContextOptions {
  /** Absent only in unit tests; every tx() then fails loudly. */
  db?: Kysely<Database>;
  subjects: SubjectLoader;
}

export const contextPlugin = fp<ContextOptions>(
  async (app, opts) => {
    // Object-valued decorators must be accessors (Fastify rule); default is
    // the public subject, the least-privileged one, until onRequest resolves it.
    const subjects = new WeakMap<FastifyRequest, RequestSubject>();
    const PUBLIC: RequestSubject = { kind: 'public' };
    app.decorateRequest('subject', {
      getter(this: FastifyRequest): RequestSubject {
        return subjects.get(this) ?? PUBLIC;
      },
      setter(this: FastifyRequest, value: RequestSubject) {
        subjects.set(this, value);
      },
    });
    app.decorateRequest('executionId', null);

    app.addHook('onRequest', async (request) => {
      const header = request.headers.authorization;
      const key = request.headers['idempotency-key'];
      request.executionId = typeof key === 'string' && /^[0-9a-f-]{36}$/i.test(key) ? key : null;

      if (!header) {
        request.subject = { kind: 'public' };
        return;
      }
      const [scheme, token] = header.split(' ');
      if (scheme !== 'Bearer' || !token) throw errors.unauthorized('malformed_authorization');
      try {
        request.subject = await opts.subjects.fromBearer(token);
      } catch (err) {
        if (err instanceof AuthError) throw errors.unauthorized(err.code);
        throw err;
      }
    });

    app.decorateRequest(
      'tx',
      function (
        this: FastifyRequest,
        fn: (trx: Transaction<Database>) => Promise<unknown>,
      ): Promise<unknown> {
        const db = opts.db;
        if (!db) throw new Error('database not configured');
        const s = this.subject;
        if (s.kind !== 'account') {
          // Public requests get a tenant only from the route (layer 2 intake).
          if (!s.tenantId) throw errors.unauthorized('tenant_required');
          return withTenant(db, { tenantId: s.tenantId }, fn);
        }
        return withTenant(
          db,
          {
            tenantId: s.tenantId,
            tenantPath: s.tenantPath,
            visibleTenantIds: s.agreementTenantIds ?? [],
            accountId: s.accountId,
          },
          fn,
        );
      },
    );

    app.decorateRequest(
      'audit',
      function (
        this: FastifyRequest,
        trx: Transaction<Database>,
        input: AuditCall,
      ): Promise<AuditReceipt> {
        const s = this.subject;
        const tenantId = input.tenantId ?? s.tenantId;
        if (!tenantId) throw new Error('audit without tenant');
        return recordAudit(trx, {
          ...input,
          tenantId,
          actorKind: s.kind === 'account' ? (s.breakGlass ? 'break_glass' : 'account') : 'public',
          actorAccountId: s.kind === 'account' ? s.accountId : null,
          requestId: this.id,
          executionId: input.executionId ?? this.executionId,
        });
      },
    );
  },
  { name: 'cg-context' },
);
