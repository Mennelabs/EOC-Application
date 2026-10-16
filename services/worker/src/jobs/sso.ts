/**
 * sso.apply (SEC-07, ADR-0008): puts the county's realm in line with the
 * single sign-on in force. With an approved provider, Keycloak gets it with
 * the link-only first sign-in and the passkey after it; with none, the
 * provider is switched off and staff sign in with password and passkey
 * again. The outcome is written on the provider (when applied, or why not)
 * for the console, and audited. A failure is retried by the broker.
 */
import type { Kysely } from 'kysely';
import type { Database } from '@cg/db';
import type { SsoProviderSpec } from '../idp/keycloak.ts';
import { asSystem, systemAudit } from '../system.ts';
import type { TopicHandler } from './types.ts';

/** True when the county signs its staff in through its own identity provider. */
export async function tenantUsesSso(db: Kysely<Database>, tenantId: string): Promise<boolean> {
  const row = await asSystem(db, tenantId, (trx) =>
    trx
      .selectFrom('cg.tenant_sso')
      .select('id')
      .where('tenant_id', '=', tenantId)
      .where('status', '=', 'active')
      .executeTakeFirst(),
  );
  return Boolean(row);
}

export const ssoApply: TopicHandler = async (ctx, msg) => {
  const tenantId = msg.tenantId;
  const tenant = await ctx.db
    .selectFrom('cg.tenant')
    .select('slug')
    .where('id', '=', tenantId)
    .executeTakeFirst();
  if (!tenant) throw new Error(`tenant ${tenantId} not found`);
  if (!(await ctx.idp.realmExists(tenant.slug))) {
    await new Promise((r) => setTimeout(r, 2000));
    throw new Error(`realm ${tenant.slug} not ready for single sign-on`);
  }
  const active = await asSystem(ctx.db, tenantId, (trx) =>
    trx
      .selectFrom('cg.tenant_sso')
      .selectAll()
      .where('tenant_id', '=', tenantId)
      .where('status', '=', 'active')
      .executeTakeFirst(),
  );
  try {
    if (active) {
      const spec: SsoProviderSpec =
        active.protocol === 'saml'
          ? {
              protocol: 'saml',
              displayName: active.display_name,
              metadata: active.saml_metadata ?? '',
            }
          : {
              protocol: 'oidc',
              displayName: active.display_name,
              issuer: active.oidc_issuer ?? '',
              authorizationUrl: active.oidc_authorization_url ?? '',
              tokenUrl: active.oidc_token_url ?? '',
              jwksUrl: active.oidc_jwks_url ?? '',
              clientId: active.oidc_client_id ?? '',
              clientSecret: await ctx.crypto.decrypt(tenantId, active.oidc_client_secret_enc!),
            };
      await ctx.idp.ensureSsoProvider(tenant.slug, spec);
    } else {
      await ctx.idp.disableSsoProvider(tenant.slug);
    }
  } catch (err) {
    if (active) {
      // Shown to administrators: the error text only, never the configuration or a secret.
      const message = (err instanceof Error ? err.message : String(err)).slice(0, 300);
      await asSystem(ctx.db, tenantId, (trx) =>
        trx
          .updateTable('cg.tenant_sso')
          .set({ apply_error: message })
          .where('id', '=', active.id)
          .execute(),
      );
    }
    throw err;
  }
  await asSystem(ctx.db, tenantId, async (trx) => {
    if (active)
      await trx
        .updateTable('cg.tenant_sso')
        .set({ applied_at: new Date(), apply_error: null })
        .where('id', '=', active.id)
        .execute();
    await systemAudit(trx, tenantId, 'sso.apply', {
      action: active ? 'sso.applied' : 'sso.switched_off',
      targetType: 'tenant_sso',
      targetId: active?.id ?? String(msg.payload['ssoId'] ?? '-'),
      changes: {
        fields: [
          { name: 'realm', to: tenant.slug },
          { name: 'protocol', to: active?.protocol ?? null },
        ],
      },
      executionId: msg.executionId,
    });
  });
  ctx.log.info({ tenantId, realm: tenant.slug, on: Boolean(active) }, 'single sign-on applied');
};
