/**
 * Builds the enclave subject for a request (SEC-12, ADR-0036): the verified
 * token names an identity; the enclave database says which account, agency,
 * roles and screening it has. Nothing is cached: a suspension, a revoked
 * role or lapsed training takes effect on the next request (AC-C05).
 */
import { sql, type Kysely } from 'kysely';
import {
  personBySubject,
  withAgency,
  type CjisDatabase,
  type EnclaveRole,
  type PersonStatus,
} from '@cg/cjis-db';
import { qualification, type EnclaveSubject } from '../policy.ts';
import { recordEnclaveAudit } from '../audit.ts';
import { AuthError, type TokenVerifier } from './token.ts';

export interface RequestSubject extends EnclaveSubject {
  kind: 'person';
  email: string;
  displayName: string;
  status: PersonStatus;
  agencyName: string;
  sessionId: string | null;
  methods: string[];
}

export interface SubjectLoader {
  fromBearer(token: string): Promise<RequestSubject>;
}

/** last_seen_at drives the 90-day inactivity suspension (AC-2); written at most every 5 minutes. */
const SEEN_WRITE_INTERVAL_MS = 5 * 60 * 1000;

export function createSubjectLoader(
  db: Kysely<CjisDatabase>,
  verify: TokenVerifier,
): SubjectLoader {
  return {
    async fromBearer(token) {
      const t = await verify(token);
      const found = await personBySubject(db, t.subject);
      if (!found) throw new AuthError('unknown_account');
      if (!t.secondFactor) {
        // A sign-in without the second factor: refused and recorded against the account.
        await withAgency(db, { agencyId: found.agency_id, personId: found.id }, (trx) =>
          recordEnclaveAudit(trx, {
            agencyId: found.agency_id,
            actorKind: 'person',
            actorPersonId: found.id,
            action: 'auth.deny',
            targetType: 'session',
            targetId: t.sessionId ?? '-',
            outcome: 'denied',
            reason: `second_factor_required (methods: ${t.methods.join(',') || 'none'})`,
          }),
        );
        throw new AuthError('second_factor_required');
      }
      return withAgency(db, { agencyId: found.agency_id, personId: found.id }, async (trx) => {
        const person = await trx
          .selectFrom('cjis.person')
          .selectAll()
          .where('id', '=', found.id)
          .executeTakeFirstOrThrow();
        const agency = await trx
          .selectFrom('cjis.agency')
          .select(['name', 'status'])
          .where('id', '=', found.agency_id)
          .executeTakeFirstOrThrow();
        const roles = (
          await trx
            .selectFrom('cjis.role_grant')
            .select('role')
            .where('person_id', '=', found.id)
            .where('status', '=', 'active')
            .execute()
        ).map((r) => r.role as EnclaveRole);
        const q = qualification({
          status: person.status,
          agencyStatus: agency.status,
          fingerprintStatus: person.fingerprint_status,
          fingerprintAdjudicatedOn: person.fingerprint_adjudicated_on,
          trainingExpiresOn: person.training_expires_on,
          roles,
        });
        if (
          person.status === 'active' &&
          (!person.last_seen_at ||
            Date.now() - person.last_seen_at.getTime() > SEEN_WRITE_INTERVAL_MS)
        ) {
          // Not a change to the account: its version stays (migration 0005).
          await sql`update cjis.person set last_seen_at = now() where id = ${found.id}::uuid`.execute(
            trx,
          );
        }
        return {
          kind: 'person' as const,
          personId: found.id,
          agencyId: found.agency_id,
          agencyName: agency.name,
          email: person.email,
          displayName: person.display_name,
          status: person.status,
          roles,
          qualified: q.qualified,
          missing: q.missing,
          sessionId: t.sessionId,
          methods: t.methods,
        };
      });
    },
  };
}
