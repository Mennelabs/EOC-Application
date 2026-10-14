/**
 * Enclave token verification (SEC-12, SEC-07, ADR-0036). A token is accepted
 * only when all of these hold:
 * - it is signed by the enclave realm's key set (fetched inside the enclave);
 * - its issuer is exactly the enclave realm as browsers see it, so a token
 *   from any platform realm (or any other issuer) is refused;
 * - its audience names the enclave API;
 * - its authentication methods (`amr`) include an accepted second factor, so
 *   a sign-in that skipped the second factor fails closed even if a flow were
 *   misconfigured (production accepts the passkey, `hwk`, only).
 * Who the subject is and whether they are CJIS-qualified is decided from the
 * enclave database on every request (subject.ts), never from claims alone.
 */
import { createRemoteJWKSet, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from 'jose';

export class AuthError extends Error {
  override readonly name = 'AuthError';
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
  }
}

export interface EnclaveClaims extends JWTPayload {
  amr?: string[] | string;
  sid?: string;
  email?: string;
  azp?: string;
}

export interface VerifiedToken {
  subject: string;
  sessionId: string | null;
  methods: string[];
  clientId: string | null;
  /** False when the sign-in skipped an accepted second factor; the loader refuses and audits it. */
  secondFactor: boolean;
}

export interface TokenSettings {
  /** e.g. https://localhost:8443/auth/realms/cjis */
  issuer: string;
  audience: string;
  secondFactors: readonly string[];
  keys: JWTVerifyGetKey;
}

export function remoteKeys(internalBase: string, realm: string): JWTVerifyGetKey {
  return createRemoteJWKSet(
    new URL(`${internalBase.replace(/\/$/, '')}/realms/${realm}/protocol/openid-connect/certs`),
    { cooldownDuration: 30_000 },
  );
}

/** Pure check of the authentication methods; exported for tests. */
export function hasSecondFactor(
  amr: EnclaveClaims['amr'],
  accepted: readonly string[],
): { ok: boolean; methods: string[] } {
  const methods = (Array.isArray(amr) ? amr : typeof amr === 'string' ? [amr] : []).filter(
    (m): m is string => typeof m === 'string',
  );
  return { ok: methods.some((m) => accepted.includes(m)), methods };
}

export function createTokenVerifier(settings: TokenSettings) {
  return async function verify(token: string): Promise<VerifiedToken> {
    let claims: EnclaveClaims;
    try {
      const verified = await jwtVerify(token, settings.keys, {
        issuer: settings.issuer,
        audience: settings.audience,
        clockTolerance: 30,
      });
      claims = verified.payload as EnclaveClaims;
    } catch {
      throw new AuthError('invalid_token');
    }
    if (!claims.sub) throw new AuthError('invalid_token');
    const factor = hasSecondFactor(claims.amr, settings.secondFactors);
    return {
      subject: claims.sub,
      sessionId: typeof claims.sid === 'string' ? claims.sid : null,
      methods: factor.methods,
      clientId: typeof claims.azp === 'string' ? claims.azp : null,
      secondFactor: factor.ok,
    };
  };
}

export type TokenVerifier = ReturnType<typeof createTokenVerifier>;
