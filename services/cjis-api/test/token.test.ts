/**
 * Enclave token verification (SEC-12, SEC-07, ADR-0036) against a local key
 * set: the enclave issuer and audience only, and a second factor in `amr`.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWK } from 'jose';
import { AuthError, createTokenVerifier, hasSecondFactor } from '../src/auth/token.ts';

const ISSUER = 'https://localhost:8443/auth/realms/cjis';
let sign: (
  claims: Record<string, unknown>,
  opts?: { issuer?: string; audience?: string; exp?: string },
) => Promise<string>;
let verify: ReturnType<typeof createTokenVerifier>;

beforeAll(async () => {
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  const jwk = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' } as JWK;
  verify = createTokenVerifier({
    issuer: ISSUER,
    audience: 'cjis-api',
    secondFactors: ['hwk'],
    keys: createLocalJWKSet({ keys: [jwk] }),
  });
  sign = (claims, opts = {}) =>
    new SignJWT(claims)
      .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
      .setIssuer(opts.issuer ?? ISSUER)
      .setAudience(opts.audience ?? 'cjis-api')
      .setSubject('user-1')
      .setIssuedAt()
      .setExpirationTime(opts.exp ?? '5m')
      .sign(privateKey);
});

describe('enclave tokens', () => {
  it('accepts the enclave issuer and audience with a passkey', async () => {
    const t = await verify(await sign({ amr: ['pwd', 'hwk'], sid: 's1' }));
    expect(t).toMatchObject({ subject: 'user-1', sessionId: 's1', secondFactor: true });
  });

  it('flags a sign-in without an accepted second factor', async () => {
    expect((await verify(await sign({ amr: ['pwd'] }))).secondFactor).toBe(false);
    expect((await verify(await sign({ amr: ['pwd', 'otp'] }))).secondFactor).toBe(false);
    expect((await verify(await sign({}))).secondFactor).toBe(false);
  });

  it('refuses a platform realm token (another issuer)', async () => {
    await expect(
      verify(await sign({ amr: ['hwk'] }, { issuer: 'https://localhost/auth/realms/county' })),
    ).rejects.toBeInstanceOf(AuthError);
  });

  it('refuses another audience', async () => {
    await expect(verify(await sign({ amr: ['hwk'] }, { audience: 'cg-console' }))).rejects.toThrow(
      'invalid_token',
    );
  });

  it('refuses an expired token', async () => {
    await expect(verify(await sign({ amr: ['hwk'] }, { exp: '-2m' }))).rejects.toThrow(
      'invalid_token',
    );
  });

  it('refuses a token signed by another key', async () => {
    const other = await generateKeyPair('RS256');
    const forged = await new SignJWT({ amr: ['hwk'] })
      .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
      .setIssuer(ISSUER)
      .setAudience('cjis-api')
      .setSubject('user-1')
      .setExpirationTime('5m')
      .sign(other.privateKey);
    await expect(verify(forged)).rejects.toThrow('invalid_token');
  });

  it('reads amr as a list or a single value', () => {
    expect(hasSecondFactor('hwk', ['hwk']).ok).toBe(true);
    expect(hasSecondFactor(['pwd'], ['hwk']).ok).toBe(false);
    expect(hasSecondFactor(undefined, ['hwk']).methods).toEqual([]);
  });
});
