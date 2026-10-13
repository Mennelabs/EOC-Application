/**
 * Sign-in for the web build (SEC-07, ADR-0008, ADR-0014): OpenID Connect
 * authorization code with PKCE against the county's realm, public client
 * `cg-field`, as the console does. Tokens stay in sessionStorage (this tab
 * only). The native app uses auth.native.ts (expo-auth-session and the
 * Keychain or Keystore). Both export the same functions.
 */
export interface Session {
  realm: string;
  accessToken: string;
  refreshToken: string | null;
  idToken: string | null;
  expiresAt: number;
  endSession: string | null;
  tokenEndpoint: string;
}

const SESSION_KEY = 'cgf.session';
const PKCE_KEY = 'cgf.pkce';
const REALM_KEY = 'cgf.realm';
const CLIENT_ID = 'cg-field';

function b64url(bytes: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

async function discover(apiBase: string, realm: string) {
  const res = await fetch(
    `${apiBase}/auth/realms/${encodeURIComponent(realm)}/.well-known/openid-configuration`,
  );
  if (!res.ok) throw new Error('unknown_organization');
  return (await res.json()) as {
    authorization_endpoint: string;
    token_endpoint: string;
    end_session_endpoint?: string;
  };
}

const redirectUri = () => `${location.origin}/field/callback`;

export function rememberedRealm(): string | null {
  try {
    return localStorage.getItem(REALM_KEY);
  } catch {
    return null;
  }
}

/** Starts sign-in; on the web the page navigates away and returns to /field/callback. */
export async function beginSignIn(apiBase: string, realm: string): Promise<Session | null> {
  const cfg = await discover(apiBase, realm);
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)).buffer);
  const challenge = b64url(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)),
  );
  const state = b64url(crypto.getRandomValues(new Uint8Array(16)).buffer);
  sessionStorage.setItem(PKCE_KEY, JSON.stringify({ verifier, state, realm }));
  try {
    localStorage.setItem(REALM_KEY, realm);
  } catch {
    /* a convenience only */
  }
  const url = new URL(cfg.authorization_endpoint);
  url.searchParams.set('client_id', CLIENT_ID);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', 'openid email profile');
  url.searchParams.set('redirect_uri', redirectUri());
  url.searchParams.set('state', state);
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  location.assign(url.toString());
  return null;
}

export async function completeSignIn(apiBase: string): Promise<Session> {
  const params = new URLSearchParams(location.search);
  const code = params.get('code');
  const state = params.get('state');
  const raw = sessionStorage.getItem(PKCE_KEY);
  sessionStorage.removeItem(PKCE_KEY);
  if (!code || !state || !raw) throw new Error('signin_incomplete');
  const pkce = JSON.parse(raw) as { verifier: string; state: string; realm: string };
  if (pkce.state !== state) throw new Error('signin_state');
  const cfg = await discover(apiBase, pkce.realm);
  const res = await fetch(cfg.token_endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: CLIENT_ID,
      code,
      redirect_uri: redirectUri(),
      code_verifier: pkce.verifier,
    }),
  });
  if (!res.ok) throw new Error('signin_rejected');
  const t = (await res.json()) as {
    access_token: string;
    refresh_token?: string;
    id_token?: string;
    expires_in: number;
  };
  const session: Session = {
    realm: pkce.realm,
    accessToken: t.access_token,
    refreshToken: t.refresh_token ?? null,
    idToken: t.id_token ?? null,
    expiresAt: Date.now() + t.expires_in * 1000,
    endSession: cfg.end_session_endpoint ?? null,
    tokenEndpoint: cfg.token_endpoint,
  };
  await saveSession(session);
  return session;
}

export async function loadSession(): Promise<Session | null> {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY);
    return raw ? (JSON.parse(raw) as Session) : null;
  } catch {
    return null;
  }
}

export async function saveSession(s: Session | null): Promise<void> {
  if (s) sessionStorage.setItem(SESSION_KEY, JSON.stringify(s));
  else sessionStorage.removeItem(SESSION_KEY);
}

/** A valid access token, refreshed within 30 s of expiry; null when signed out. */
export async function accessToken(): Promise<string | null> {
  const s = await loadSession();
  if (!s) return null;
  if (s.expiresAt - Date.now() > 30_000) return s.accessToken;
  if (!s.refreshToken) {
    await saveSession(null);
    return null;
  }
  const res = await fetch(s.tokenEndpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: CLIENT_ID,
      refresh_token: s.refreshToken,
    }),
  });
  if (!res.ok) {
    if (res.status === 400 || res.status === 401) await saveSession(null);
    return null;
  }
  const t = (await res.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in: number;
  };
  const next: Session = {
    ...s,
    accessToken: t.access_token,
    refreshToken: t.refresh_token ?? s.refreshToken,
    expiresAt: Date.now() + t.expires_in * 1000,
  };
  await saveSession(next);
  return next.accessToken;
}

export async function signOut(): Promise<void> {
  const s = await loadSession();
  await saveSession(null);
  if (s?.endSession) {
    const url = new URL(s.endSession);
    if (s.idToken) url.searchParams.set('id_token_hint', s.idToken);
    url.searchParams.set('post_logout_redirect_uri', `${location.origin}/field/`);
    location.assign(url.toString());
  }
}
