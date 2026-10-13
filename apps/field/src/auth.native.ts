/**
 * Sign-in on the phone (SEC-07, ADR-0014): OIDC with PKCE through
 * expo-auth-session against the county's realm, public client `cg-field`,
 * returning through the app's own scheme. The refresh token lives in the
 * Keychain or Keystore (expo-secure-store), never in app storage.
 */
import * as AuthSession from 'expo-auth-session';
import * as SecureStore from 'expo-secure-store';
import * as WebBrowser from 'expo-web-browser';
import type { Session } from './auth.ts';

export type { Session } from './auth.ts';

WebBrowser.maybeCompleteAuthSession();

const SESSION_KEY = 'cgf.session';
const REALM_KEY = 'cgf.realm';
const CLIENT_ID = 'cg-field';
let realmCache: string | null = null;

export function rememberedRealm(): string | null {
  return realmCache;
}

export async function beginSignIn(apiBase: string, realm: string): Promise<Session | null> {
  const issuer = `${apiBase}/auth/realms/${encodeURIComponent(realm)}`;
  const discovery = await AuthSession.fetchDiscoveryAsync(issuer);
  const redirectUri = AuthSession.makeRedirectUri({ scheme: 'cgfield', path: 'callback' });
  const request = new AuthSession.AuthRequest({
    clientId: CLIENT_ID,
    redirectUri,
    scopes: ['openid', 'email', 'profile'],
    usePKCE: true,
  });
  const result = await request.promptAsync(discovery);
  if (result.type !== 'success') return null;
  const tokens = await AuthSession.exchangeCodeAsync(
    {
      clientId: CLIENT_ID,
      code: result.params['code'] ?? '',
      redirectUri,
      extraParams: { code_verifier: request.codeVerifier ?? '' },
    },
    discovery,
  );
  const session: Session = {
    realm,
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken ?? null,
    idToken: tokens.idToken ?? null,
    expiresAt: Date.now() + (tokens.expiresIn ?? 300) * 1000,
    endSession: discovery.endSessionEndpoint ?? null,
    tokenEndpoint: discovery.tokenEndpoint ?? `${issuer}/protocol/openid-connect/token`,
  };
  realmCache = realm;
  await SecureStore.setItemAsync(REALM_KEY, realm);
  await saveSession(session);
  return session;
}

export async function completeSignIn(_apiBase: string): Promise<Session> {
  const s = await loadSession();
  if (!s) throw new Error('signin_incomplete');
  return s;
}

export async function loadSession(): Promise<Session | null> {
  realmCache ??= await SecureStore.getItemAsync(REALM_KEY);
  const raw = await SecureStore.getItemAsync(SESSION_KEY);
  return raw ? (JSON.parse(raw) as Session) : null;
}

export async function saveSession(s: Session | null): Promise<void> {
  if (s) await SecureStore.setItemAsync(SESSION_KEY, JSON.stringify(s));
  else await SecureStore.deleteItemAsync(SESSION_KEY);
}

export async function accessToken(): Promise<string | null> {
  const s = await loadSession();
  if (!s) return null;
  if (s.expiresAt - Date.now() > 30_000) return s.accessToken;
  if (!s.refreshToken) {
    await saveSession(null);
    return null;
  }
  try {
    const t = await AuthSession.refreshAsync(
      { clientId: CLIENT_ID, refreshToken: s.refreshToken },
      { tokenEndpoint: s.tokenEndpoint },
    );
    const next: Session = {
      ...s,
      accessToken: t.accessToken,
      refreshToken: t.refreshToken ?? s.refreshToken,
      expiresAt: Date.now() + (t.expiresIn ?? 300) * 1000,
    };
    await saveSession(next);
    return next.accessToken;
  } catch {
    return null; // offline: the outbox keeps the work until a token can be refreshed
  }
}

export async function signOut(): Promise<void> {
  await saveSession(null);
}
