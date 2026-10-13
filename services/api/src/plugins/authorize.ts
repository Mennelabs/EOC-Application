/**
 * request.authorize(action, resource): the single gate every route passes
 * (BRD:FR-00.01). Denials are generic (AC-C03) and audited for signed-in
 * subjects (MET-10). Consequential actions (RULE-14) need `X-Confirm: true`
 * and a reason in `X-Reason` before anything runs.
 */
import fp from 'fastify-plugin';
import type { FastifyRequest } from 'fastify';
import type { Kysely } from 'kysely';
import { withTenant, type Database } from '@cg/db';
import { recordAudit } from '@cg/audit';
import {
  actions,
  decide,
  isActionKey,
  type Decision,
  type Resource,
  type TenantPolicy,
} from '@cg/authz';
import { errors } from '../errors.ts';

export interface AuthorizeOptions {
  /** Return 404 instead of 403 so a denied lookup does not confirm existence. */
  asNotFound?: boolean;
  /** Skip the confirmation requirement (used by the confirmation UI itself, never by bulk paths). */
  policy?: TenantPolicy;
}

declare module 'fastify' {
  interface FastifyRequest {
    authorize(action: string, resource: Resource, options?: AuthorizeOptions): Promise<Decision>;
    confirmation(): { confirmed: boolean; reason: string | null };
  }
}

export const authorizePlugin = fp<{ db?: Kysely<Database> }>(
  async (app, opts) => {
    app.decorateRequest('confirmation', function (this: FastifyRequest) {
      const confirmed = this.headers['x-confirm'] === 'true';
      const raw = this.headers['x-reason'];
      const reason =
        typeof raw === 'string' && raw.trim().length >= 3 ? raw.trim().slice(0, 500) : null;
      return { confirmed, reason };
    });

    app.decorateRequest(
      'authorize',
      async function (
        this: FastifyRequest,
        action: string,
        resource: Resource,
        options: AuthorizeOptions = {},
      ): Promise<Decision> {
        const decision = decide(this.subject, action, resource, { policy: options.policy ?? {} });

        if (decision.effect === 'deny') {
          const s = this.subject;
          const db = opts.db;
          if (s.kind === 'account' && db) {
            // Audit the attempt in its own transaction: the request itself does nothing.
            await withTenant(
              db,
              { tenantId: s.tenantId, tenantPath: s.tenantPath, accountId: s.accountId },
              (trx) =>
                recordAudit(trx, {
                  tenantId: s.tenantId,
                  actorKind: s.breakGlass ? 'break_glass' : 'account',
                  actorAccountId: s.accountId,
                  action: 'authz.deny',
                  targetType: resource.type,
                  targetId: resource.id ?? '-',
                  requestId: this.id,
                  reason: `${action}: ${decision.reason}`,
                }),
            ).catch((err: unknown) => this.log.warn({ err }, 'could not audit denial'));
            this.log.info({ action, reason: decision.reason }, 'denied');
          }
          // A guardrail on a record the subject holds the grant for (G4: no
          // self-review) is a refusal the subject may see; a missing grant stays
          // a 404 so the route does not reveal the record (default deny).
          const hide = options.asNotFound && decision.guardrail !== 'G4';
          throw hide ? errors.notFound() : errors.forbidden();
        }

        if (decision.consequential) {
          const { confirmed, reason } = this.confirmation();
          if (!confirmed || !reason) {
            const description = isActionKey(action) ? actions[action].description : action;
            throw errors.confirmationRequired(action, description);
          }
        }
        return decision;
      },
    );
  },
  { name: 'cg-authorize', dependencies: ['cg-context'] },
);
