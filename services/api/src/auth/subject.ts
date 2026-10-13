/**
 * Builds the authorization subject for a request (ADR-0008, ADR-0011).
 *
 * Staff tokens come from the tenant's Keycloak realm. Each realm adds a
 * hard-coded claim `cg_tenant_id`; the token is trusted only if its issuer is
 * exactly `${IDP_PUBLIC_BASE}/realms/${tenant.slug}` for that tenant and its
 * signature verifies against that realm's JWKS. Roles are loaded fresh on
 * every request (AC-C05): there is no cached permission state.
 */
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import type { Kysely } from 'kysely';
import { withTenant, type Database } from '@cg/db';
import type { AccountSubject, Grant, ResolvedRole } from '@cg/authz';

export interface IdpSettings {
  internalBase: string;
  publicBase: string;
}

export interface TokenClaims extends JWTPayload {
  cg_tenant_id?: string;
  email?: string;
  preferred_username?: string;
}

const jwksByRealm = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

function jwksFor(settings: IdpSettings, slug: string) {
  let set = jwksByRealm.get(slug);
  if (!set) {
    set = createRemoteJWKSet(
      new URL(`${settings.internalBase}/realms/${slug}/protocol/openid-connect/certs`),
      { cooldownDuration: 30_000 },
    );
    jwksByRealm.set(slug, set);
  }
  return set;
}

export class AuthError extends Error {
  override readonly name = 'AuthError';
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
  }
}

function decodeUnverified(token: string): TokenClaims {
  const parts = token.split('.');
  if (parts.length !== 3 || !parts[1]) throw new AuthError('malformed_token');
  try {
    return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as TokenClaims;
  } catch {
    throw new AuthError('malformed_token');
  }
}

export interface SubjectLoader {
  fromBearer(token: string): Promise<AccountSubject>;
}

export function createSubjectLoader(db: Kysely<Database>, settings: IdpSettings): SubjectLoader {
  return {
    async fromBearer(token) {
      // 1. Which tenant claims this token? (unverified read, verified below)
      const hint = decodeUnverified(token);
      const tenantId = hint.cg_tenant_id;
      if (!tenantId || !/^[0-9a-f-]{36}$/i.test(tenantId))
        throw new AuthError('tenant_claim_missing');

      // 2. Load the tenant inside its own RLS context and pin the expected issuer.
      const tenant = await withTenant(db, { tenantId }, (trx) =>
        trx
          .selectFrom('cg.tenant')
          .select(['id', 'slug', 'path', 'status', 'kind'])
          .where('id', '=', tenantId)
          .executeTakeFirst(),
      );
      if (!tenant) throw new AuthError('unknown_tenant');
      if (tenant.status !== 'active') throw new AuthError('tenant_inactive');
      const issuer = `${settings.publicBase}/realms/${tenant.slug}`;

      // 3. Verify signature, issuer, expiry.
      let claims: TokenClaims;
      try {
        const verified = await jwtVerify(token, jwksFor(settings, tenant.slug), {
          issuer,
          clockTolerance: 30,
        });
        claims = verified.payload as TokenClaims;
      } catch {
        throw new AuthError('invalid_token');
      }
      if (claims.cg_tenant_id !== tenantId || !claims.sub) throw new AuthError('invalid_token');
      const sub = claims.sub;

      // 4. Account, roles, agreements, break-glass: all fresh, all inside RLS.
      return withTenant(db, { tenantId, tenantPath: tenant.path }, async (trx) => {
        const account = await trx
          .selectFrom('cg.account')
          .select(['id', 'status'])
          .where('tenant_id', '=', tenantId)
          .where('idp_subject', '=', sub)
          .executeTakeFirst();
        if (!account) throw new AuthError('unknown_account');

        const assignments = await trx
          .selectFrom('cg.role_assignment as a')
          .innerJoin('cg.role as r', 'r.id', 'a.role_id')
          .innerJoin('cg.role_version as v', (join) =>
            join.onRef('v.role_id', '=', 'r.id').onRef('v.version', '=', 'r.current_version'),
          )
          .select([
            'r.id as roleId',
            'r.key',
            'r.template_key',
            'r.current_version',
            'v.grants',
            'a.scope',
          ])
          .where('a.account_id', '=', account.id)
          .where('a.status', '=', 'active')
          .where('r.status', '=', 'active')
          .where((eb) => eb.or([eb('a.valid_to', 'is', null), eb('a.valid_to', '>', new Date())]))
          .execute();

        const roles: ResolvedRole[] = assignments.map((a) => ({
          roleId: a.roleId,
          key: a.key,
          version: a.current_version,
          templateKey: a.template_key,
          grants: a.grants as Grant[],
          scope: (a.scope as { eventIds?: string[] }) ?? {},
        }));

        const agreements = await trx
          .selectFrom('cg.data_sharing_agreement')
          .select('from_tenant_id')
          .where('to_tenant_id', '=', tenantId)
          .where('status', '=', 'signed')
          // Consented-record agreements share through share_grant projections only (NED-04,
          // SEC-05/06); only a full-records agreement opens the other tenant's tables (SCL-01).
          .where('scope', '=', 'full_records')
          .execute();

        const breakGlass = await trx
          .selectFrom('cg.break_glass_session')
          .select(['id', 'expires_at'])
          .where('account_id', '=', account.id)
          .where('ended_at', 'is', null)
          .where('expires_at', '>', new Date())
          .orderBy('expires_at', 'desc')
          .executeTakeFirst();

        return {
          kind: 'account',
          accountId: account.id,
          tenantId,
          tenantPath: tenant.path,
          tenantKind: tenant.kind,
          status: account.status,
          roles,
          agreementTenantIds: agreements.map((a) => a.from_tenant_id),
          ...(breakGlass
            ? { breakGlass: { id: breakGlass.id, expiresAt: breakGlass.expires_at } }
            : {}),
          resolvedAt: new Date(),
        };
      });
    },
  };
}
