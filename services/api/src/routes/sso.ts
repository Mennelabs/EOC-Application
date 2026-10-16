/**
 * Single sign-on through the county's own identity provider (SEC-07,
 * ADR-0008, plan reading 49).
 *
 * - An administrator proposes the provider: SAML metadata, or OIDC addresses
 *   with a client id and secret. A second administrator approves or declines
 *   it, never the one who proposed it (ADM-05, G6). Either may switch it off.
 * - The approved provider is put in force on the county's realm by the
 *   worker (`sso.apply`). A county sign-in only links to an account the
 *   county already invited (no account is ever created by it), and the
 *   person's passkey is still asked for after it (phishing-resistant MFA).
 * - Everything is confirmed with a reason and audited. The OIDC client secret
 *   is kept encrypted under the tenant key and never returned, logged or
 *   written to the audit; the metadata itself is not copied into the audit.
 */
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { TenantSsoStatus } from '@cg/db';
import { errors } from '../errors.ts';
import { assertUpdated } from '../plugins/versions.ts';
import { httpsUrlProblem, screenSamlMetadata, serviceProvider } from '../sso-config.ts';
import { enqueueOutbox, iso, uuidParam } from './helpers.ts';

export interface SsoDeps {
  /** Where browsers reach Keycloak, e.g. https://county.example.gov/auth. */
  idpPublicBase?: string;
}

const STATUSES = ['proposed', 'active', 'declined', 'replaced', 'disabled'] as const;

const ssoOut = z.object({
  id: z.uuid(),
  version: z.number().int(),
  protocol: z.enum(['saml', 'oidc']),
  displayName: z.string(),
  idpEntityId: z.string().nullable(),
  oidc: z
    .object({
      issuer: z.string(),
      authorizationUrl: z.string(),
      tokenUrl: z.string(),
      jwksUrl: z.string(),
      clientId: z.string(),
    })
    .nullable(),
  status: z.enum(STATUSES),
  reason: z.string(),
  createdAt: z.iso.datetime(),
  createdBy: z.string().nullable(),
  askedByYou: z.boolean(),
  decidedBy: z.string().nullable(),
  decidedAt: z.iso.datetime().nullable(),
  decisionReason: z.string().nullable(),
  disabledAt: z.iso.datetime().nullable(),
  disabledReason: z.string().nullable(),
  appliedAt: z.iso.datetime().nullable(),
  applyError: z.string().nullable(),
});
type SsoOut = z.infer<typeof ssoOut>;

const serviceProviderOut = z.object({
  entityId: z.string(),
  redirectUri: z.string(),
  metadataUrl: z.string(),
});

const proposalIn = z.discriminatedUnion('protocol', [
  z.object({
    protocol: z.literal('saml'),
    displayName: z.string().trim().min(2).max(80),
    metadata: z.string().trim().min(100).max(200_000),
  }),
  z.object({
    protocol: z.literal('oidc'),
    displayName: z.string().trim().min(2).max(80),
    issuer: z.string().trim().max(500),
    authorizationUrl: z.string().trim().max(500),
    tokenUrl: z.string().trim().max(500),
    jwksUrl: z.string().trim().max(500),
    clientId: z.string().trim().min(1).max(255),
    clientSecret: z.string().min(1).max(500),
  }),
]);

interface SsoRow {
  id: string;
  version: number;
  protocol: 'saml' | 'oidc';
  display_name: string;
  idp_entity_id: string | null;
  oidc_issuer: string | null;
  oidc_authorization_url: string | null;
  oidc_token_url: string | null;
  oidc_jwks_url: string | null;
  oidc_client_id: string | null;
  status: TenantSsoStatus;
  reason: string;
  created_at: Date;
  created_by: string;
  decided_by: string | null;
  decided_at: Date | null;
  decision_reason: string | null;
  disabled_at: Date | null;
  disabled_reason: string | null;
  applied_at: Date | null;
  apply_error: string | null;
}

/** Never the metadata body or the secret: only what an administrator needs to recognise it. */
const VIEW_COLUMNS = [
  'id',
  'version',
  'protocol',
  'display_name',
  'idp_entity_id',
  'oidc_issuer',
  'oidc_authorization_url',
  'oidc_token_url',
  'oidc_jwks_url',
  'oidc_client_id',
  'status',
  'reason',
  'created_at',
  'created_by',
  'decided_by',
  'decided_at',
  'decision_reason',
  'disabled_at',
  'disabled_reason',
  'applied_at',
  'apply_error',
] as const;

type Names = Map<string, string>;

const view = (r: SsoRow, names: Names, me: string): SsoOut => ({
  id: r.id,
  version: r.version,
  protocol: r.protocol,
  displayName: r.display_name,
  idpEntityId: r.idp_entity_id,
  oidc:
    r.protocol === 'oidc'
      ? {
          issuer: r.oidc_issuer ?? '',
          authorizationUrl: r.oidc_authorization_url ?? '',
          tokenUrl: r.oidc_token_url ?? '',
          jwksUrl: r.oidc_jwks_url ?? '',
          clientId: r.oidc_client_id ?? '',
        }
      : null,
  status: r.status,
  reason: r.reason,
  createdAt: iso(r.created_at)!,
  createdBy: names.get(r.created_by) ?? null,
  askedByYou: r.created_by === me,
  decidedBy: r.decided_by ? (names.get(r.decided_by) ?? null) : null,
  decidedAt: iso(r.decided_at),
  decisionReason: r.decision_reason,
  disabledAt: iso(r.disabled_at),
  disabledReason: r.disabled_reason,
  appliedAt: iso(r.applied_at),
  applyError: r.apply_error,
});

export const ssoRoutes =
  (deps: SsoDeps = {}): FastifyPluginAsync =>
  async (raw) => {
    const app = raw.withTypeProvider<ZodTypeProvider>();
    const idpPublicBase = deps.idpPublicBase ?? 'https://localhost/auth';
    const account = (request: FastifyRequest) => {
      const s = request.subject;
      if (s.kind !== 'account') throw errors.unauthorized();
      return s;
    };
    type Trx = Parameters<Parameters<FastifyRequest['tx']>[0]>[0];
    const namesOf = async (trx: Trx, ids: (string | null | undefined)[]): Promise<Names> => {
      const wanted = [...new Set(ids.filter((x): x is string => !!x))];
      if (!wanted.length) return new Map();
      const rows = await trx
        .selectFrom('cg.account')
        .select(['id', 'display_name'])
        .where('id', 'in', wanted)
        .execute();
      return new Map(rows.map((r) => [r.id, r.display_name]));
    };
    const slugOf = async (trx: Trx, tenantId: string) =>
      (
        await trx
          .selectFrom('cg.tenant')
          .select('slug')
          .where('id', '=', tenantId)
          .executeTakeFirstOrThrow()
      ).slug;

    app.get(
      '/sso',
      {
        schema: {
          tags: ['sso'],
          response: {
            200: z.object({
              serviceProvider: serviceProviderOut,
              active: ssoOut.nullable(),
              proposed: ssoOut.nullable(),
              history: z.array(ssoOut),
            }),
          },
        },
      },
      async (request) => {
        const s = account(request);
        await request.authorize('sso.read', { type: 'tenant_sso', tenantId: s.tenantId });
        return request.tx(async (trx) => {
          const rows = (await trx
            .selectFrom('cg.tenant_sso')
            .select(VIEW_COLUMNS)
            .where('tenant_id', '=', s.tenantId)
            .orderBy('created_at', 'desc')
            .limit(20)
            .execute()) as SsoRow[];
          const names = await namesOf(
            trx,
            rows.flatMap((r) => [r.created_by, r.decided_by]),
          );
          const out = rows.map((r) => view(r, names, s.accountId));
          return {
            serviceProvider: serviceProvider(idpPublicBase, await slugOf(trx, s.tenantId)),
            active: out.find((r) => r.status === 'active') ?? null,
            proposed: out.find((r) => r.status === 'proposed') ?? null,
            history: out.filter((r) => r.status !== 'active' && r.status !== 'proposed'),
          };
        });
      },
    );

    app.post(
      '/sso',
      { schema: { tags: ['sso'], body: proposalIn, response: { 201: ssoOut } } },
      async (request, reply) => {
        const s = account(request);
        const body = request.body;
        let entityId: string;
        if (body.protocol === 'saml') {
          const screened = screenSamlMetadata(body.metadata);
          if (screened.problem)
            throw errors.validation([{ name: 'metadata', message: screened.problem }]);
          entityId = screened.entityId!;
        } else {
          const problems = (['issuer', 'authorizationUrl', 'tokenUrl', 'jwksUrl'] as const).flatMap(
            (name) => {
              const message = httpsUrlProblem(body[name]);
              return message ? [{ name, message }] : [];
            },
          );
          if (problems.length) throw errors.validation(problems);
          entityId = body.issuer;
        }
        await request.authorize('sso.manage', { type: 'tenant_sso', tenantId: s.tenantId });
        const { reason } = request.confirmation();
        const secretEnc =
          body.protocol === 'oidc'
            ? await app.fieldCrypto.encrypt(s.tenantId, body.clientSecret)
            : null;
        const out = await request.tx(async (trx) => {
          const waiting = (await trx
            .selectFrom('cg.tenant_sso')
            .select(VIEW_COLUMNS)
            .where('tenant_id', '=', s.tenantId)
            .where('status', '=', 'proposed')
            .executeTakeFirst()) as SsoRow | undefined;
          // One proposal waits at a time: decline it before proposing another.
          if (waiting) throw errors.conflict(view(waiting, new Map(), s.accountId));
          const row = (await trx
            .insertInto('cg.tenant_sso')
            .values({
              tenant_id: s.tenantId,
              protocol: body.protocol,
              display_name: body.displayName,
              idp_entity_id: entityId,
              // sso.manage is consequential: authorize has already demanded a reason.
              reason: reason!,
              created_by: s.accountId,
              ...(body.protocol === 'saml'
                ? { saml_metadata: body.metadata }
                : {
                    oidc_issuer: body.issuer,
                    oidc_authorization_url: body.authorizationUrl,
                    oidc_token_url: body.tokenUrl,
                    oidc_jwks_url: body.jwksUrl,
                    oidc_client_id: body.clientId,
                    oidc_client_secret_enc: secretEnc,
                  }),
            })
            .returning(VIEW_COLUMNS)
            .executeTakeFirstOrThrow()) as SsoRow;
          await request.audit(trx, {
            action: 'sso.manage',
            targetType: 'tenant_sso',
            targetId: row.id,
            targetVersion: row.version,
            changes: {
              op: 'propose',
              protocol: row.protocol,
              displayName: row.display_name,
              idp: entityId,
            },
            reason,
          });
          const names = await namesOf(trx, [s.accountId]);
          return view(row, names, s.accountId);
        });
        return reply.code(201).send(out);
      },
    );

    for (const op of ['approve', 'decline', 'disable'] as const) {
      app.post(
        `/sso/:id/${op}`,
        {
          config: { requiresVersion: true },
          schema: { tags: ['sso'], params: uuidParam, response: { 200: ssoOut } },
        },
        async (request) => {
          const s = account(request);
          const expected = request.expectedVersion();
          const current = (await request.tx((trx) =>
            trx
              .selectFrom('cg.tenant_sso')
              .select(VIEW_COLUMNS)
              .where('id', '=', request.params.id)
              .executeTakeFirst(),
          )) as SsoRow | undefined;
          if (!current) throw errors.notFound();
          await request.authorize(
            'sso.read',
            { type: 'tenant_sso', id: current.id, tenantId: s.tenantId },
            { asNotFound: true },
          );
          await request.authorize('sso.manage', {
            type: 'tenant_sso',
            id: current.id,
            tenantId: s.tenantId,
            ...(op === 'disable' ? {} : { requestedBy: current.created_by }),
          });
          const { reason } = request.confirmation();
          const unchanged = () => view(current, new Map(), s.accountId);
          if (op === 'disable' ? current.status !== 'active' : current.status !== 'proposed')
            throw errors.conflict(unchanged());
          const now = new Date();
          return request.tx(async (trx) => {
            let replaced: string | null = null;
            if (op === 'approve') {
              // The provider in force gives way to the approved one (one active at a time).
              const previous = await trx
                .updateTable('cg.tenant_sso')
                .set({ status: 'replaced' })
                .where('tenant_id', '=', s.tenantId)
                .where('status', '=', 'active')
                .returning('id')
                .executeTakeFirst();
              replaced = previous?.id ?? null;
            }
            const row = assertUpdated(
              (await trx
                .updateTable('cg.tenant_sso')
                .set(
                  op === 'disable'
                    ? {
                        status: 'disabled',
                        disabled_by: s.accountId,
                        disabled_at: now,
                        disabled_reason: reason,
                      }
                    : {
                        status: op === 'approve' ? 'active' : 'declined',
                        decided_by: s.accountId,
                        decided_at: now,
                        decision_reason: reason,
                        applied_at: null,
                        apply_error: null,
                      },
                )
                .where('id', '=', current.id)
                .where('version', '=', expected)
                .returning(VIEW_COLUMNS)
                .executeTakeFirst()) as SsoRow | undefined,
              unchanged(),
            );
            await request.audit(trx, {
              action: 'sso.manage',
              targetType: 'tenant_sso',
              targetId: row.id,
              targetVersion: row.version,
              changes: {
                op,
                from: current.status,
                to: row.status,
                ...(replaced ? { replaced } : {}),
              },
              reason,
            });
            // The worker puts the county's realm in line with what is now in force.
            if (op !== 'decline')
              await enqueueOutbox(
                trx,
                s.tenantId,
                'sso.apply',
                { ssoId: row.id },
                request.executionId,
              );
            const names = await namesOf(trx, [row.created_by, row.decided_by]);
            return view(row, names, s.accountId);
          });
        },
      );
    }
  };
