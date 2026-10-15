/**
 * OpenID Connect authorization code flow with PKCE against the tenant's
 * Keycloak realm (SEC-07, ADR-0008). Public client `cg-console`; no client
 * secret. Tokens live in memory and sessionStorage (this tab only), never in
 * localStorage, so a shared device does not hand the next person a session
 * (ACC-41, AC-A07). The realm (tenant slug) is the only thing remembered.
 */
export interface Session {
  realm: string;
  accessToken: string;
  refreshToken: string | null;
  idToken: string | null;
  expiresAt: number;
  issuer: string;
  endSession: string | null;
}

const SESSION_KEY = 'cg.session';
const PKCE_KEY = 'cg.pkce';
const REALM_KEY = 'cg.realm';

function base64url(bytes: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

async function discover(realm: string) {
  const res = await fetch(
    `/auth/realms/${encodeURIComponent(realm)}/.well-known/openid-configuration`,
  );
  if (!res.ok) throw new Error(`Unknown organization "${realm}"`);
  return (await res.json()) as {
    issuer: string;
    authorization_endpoint: string;
    token_endpoint: string;
    end_session_endpoint?: string;
  };
}

export function rememberedRealm(): string | null {
  try {
    return localStorage.getItem(REALM_KEY);
  } catch {
    return null;
  }
}

export async function beginLogin(realm: string): Promise<void> {
  const cfg = await discover(realm);
  const verifierBytes = crypto.getRandomValues(new Uint8Array(32));
  const verifier = base64url(verifierBytes.buffer);
  const challenge = base64url(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)),
  );
  const state = base64url(crypto.getRandomValues(new Uint8Array(16)).buffer);
  sessionStorage.setItem(
    PKCE_KEY,
    JSON.stringify({ verifier, state, realm, returnTo: location.pathname + location.search }),
  );
  try {
    localStorage.setItem(REALM_KEY, realm);
  } catch {
    /* remembering the realm is a convenience only */
  }
  const url = new URL(cfg.authorization_endpoint);
  url.searchParams.set('client_id', 'cg-console');
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', 'openid email profile');
  url.searchParams.set('redirect_uri', redirectUri());
  url.searchParams.set('state', state);
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  location.assign(url.toString());
}

function redirectUri(): string {
  return `${location.origin}/console/callback`;
}

/** Handles /console/callback; returns the path to continue to. */
export async function completeLogin(): Promise<string> {
  const params = new URLSearchParams(location.search);
  const code = params.get('code');
  const state = params.get('state');
  const raw = sessionStorage.getItem(PKCE_KEY);
  sessionStorage.removeItem(PKCE_KEY);
  if (!code || !state || !raw) throw new Error('Sign-in did not complete. Please try again.');
  const pkce = JSON.parse(raw) as {
    verifier: string;
    state: string;
    realm: string;
    returnTo: string;
  };
  if (pkce.state !== state) throw new Error('Sign-in state did not match. Please try again.');
  const cfg = await discover(pkce.realm);
  const res = await fetch(cfg.token_endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: 'cg-console',
      code,
      redirect_uri: redirectUri(),
      code_verifier: pkce.verifier,
    }),
  });
  if (!res.ok) throw new Error('Sign-in was not accepted. Please try again.');
  const t = (await res.json()) as {
    access_token: string;
    refresh_token?: string;
    id_token?: string;
    expires_in: number;
  };
  saveSession({
    realm: pkce.realm,
    accessToken: t.access_token,
    refreshToken: t.refresh_token ?? null,
    idToken: t.id_token ?? null,
    expiresAt: Date.now() + t.expires_in * 1000,
    issuer: cfg.issuer,
    endSession: cfg.end_session_endpoint ?? null,
  });
  return pkce.returnTo && !pkce.returnTo.includes('/callback') ? pkce.returnTo : '/console/';
}

export function loadSession(): Session | null {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY);
    return raw ? (JSON.parse(raw) as Session) : null;
  } catch {
    return null;
  }
}

function saveSession(s: Session | null): void {
  if (s) sessionStorage.setItem(SESSION_KEY, JSON.stringify(s));
  else sessionStorage.removeItem(SESSION_KEY);
}

/** A valid access token, refreshed when within 30 s of expiry; null when signed out. */
export async function accessToken(): Promise<string | null> {
  const s = loadSession();
  if (!s) return null;
  if (s.expiresAt - Date.now() > 30_000) return s.accessToken;
  if (!s.refreshToken) {
    saveSession(null);
    return null;
  }
  const cfg = await discover(s.realm);
  const res = await fetch(cfg.token_endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: 'cg-console',
      refresh_token: s.refreshToken,
    }),
  });
  if (!res.ok) {
    saveSession(null);
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
  saveSession(next);
  return next.accessToken;
}

export function signOut(): void {
  const s = loadSession();
  saveSession(null);
  if (s?.endSession) {
    const url = new URL(s.endSession);
    if (s.idToken) url.searchParams.set('id_token_hint', s.idToken);
    url.searchParams.set('post_logout_redirect_uri', `${location.origin}/console/`);
    location.assign(url.toString());
  } else {
    location.assign('/console/');
  }
}

/** The display claims in the ID token (name, email), read on the device for the top bar; nothing is trusted from them. */
export function sessionClaims(
  s: Session,
): { name?: string; email?: string; preferredUsername?: string } | null {
  if (!s.idToken) return null;
  try {
    const payload = s.idToken.split('.')[1];
    if (!payload) return null;
    const json = atob(payload.replace(/-/g, '+').replace(/_/g, '/'));
    const c = JSON.parse(json) as Record<string, unknown>;
    const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined);
    const out: { name?: string; email?: string; preferredUsername?: string } = {};
    const name = str(c['name']);
    const email = str(c['email']);
    const preferred = str(c['preferred_username']);
    if (name) out.name = name;
    if (email) out.email = email;
    if (preferred) out.preferredUsername = preferred;
    return out;
  } catch {
    return null;
  }
}
