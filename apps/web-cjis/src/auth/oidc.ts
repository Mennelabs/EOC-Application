/**
 * Sign-in to the CJIS enclave (SEC-12, SEC-07, ADR-0036/0038): authorization
 * code with PKCE against the enclave's own realm on this origin, public
 * client `cjis-web`. The platform's sign-in never reaches here. Tokens live
 * in memory and sessionStorage for this tab only, never in localStorage, and
 * are dropped when the app locks after 30 minutes without activity (AC-11).
 */
export interface Session {
  accessToken: string;
  refreshToken: string | null;
  idToken: string | null;
  expiresAt: number;
}

const REALM = 'cjis';
const CLIENT = 'cjis-web';
const SESSION_KEY = 'cjis.session';
const PKCE_KEY = 'cjis.pkce';
const base = () => `${location.origin}/auth/realms/${REALM}/protocol/openid-connect`;

function base64url(bytes: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

const redirectUri = () => `${location.origin}/callback`;

/**
 * `reauthenticate` forces the full sign-in (prompt=login): after a first sign-in that
 * registered the passkey, the session holds the password only, and the enclave API
 * refuses it until the person signs in with the passkey (fail closed, ADR-0036).
 */
export async function beginLogin(
  returnTo = location.pathname + location.search,
  opts: { reauthenticate?: boolean } = {},
): Promise<void> {
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)).buffer);
  const challenge = base64url(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)),
  );
  const state = base64url(crypto.getRandomValues(new Uint8Array(16)).buffer);
  sessionStorage.setItem(PKCE_KEY, JSON.stringify({ verifier, state, returnTo }));
  const url = new URL(`${base()}/auth`);
  url.searchParams.set('client_id', CLIENT);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', 'openid');
  url.searchParams.set('redirect_uri', redirectUri());
  url.searchParams.set('state', state);
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  if (opts.reauthenticate) url.searchParams.set('prompt', 'login');
  location.assign(url.toString());
}

/** Handles /callback; returns where to continue. */
export async function completeLogin(): Promise<string> {
  const params = new URLSearchParams(location.search);
  const code = params.get('code');
  const state = params.get('state');
  const raw = sessionStorage.getItem(PKCE_KEY);
  sessionStorage.removeItem(PKCE_KEY);
  if (!code || !state || !raw) throw new Error('Sign-in did not complete. Please try again.');
  const pkce = JSON.parse(raw) as { verifier: string; state: string; returnTo: string };
  if (pkce.state !== state) throw new Error('Sign-in state did not match. Please try again.');
  const res = await fetch(`${base()}/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: CLIENT,
      code,
      redirect_uri: redirectUri(),
      code_verifier: pkce.verifier,
    }),
  });
  if (!res.ok) throw new Error('Sign-in was not accepted. Please try again.');
  save((await res.json()) as TokenResponse);
  return pkce.returnTo && !pkce.returnTo.startsWith('/callback') ? pkce.returnTo : '/';
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  id_token?: string;
  expires_in: number;
}

function save(t: TokenResponse, previous?: Session): void {
  const s: Session = {
    accessToken: t.access_token,
    refreshToken: t.refresh_token ?? previous?.refreshToken ?? null,
    idToken: t.id_token ?? previous?.idToken ?? null,
    expiresAt: Date.now() + t.expires_in * 1000,
  };
  sessionStorage.setItem(SESSION_KEY, JSON.stringify(s));
}

export function loadSession(): Session | null {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY);
    return raw ? (JSON.parse(raw) as Session) : null;
  } catch {
    return null;
  }
}

export function forgetSession(): void {
  sessionStorage.removeItem(SESSION_KEY);
}

/** A valid access token, refreshed near expiry; null when signed out. */
export async function accessToken(): Promise<string | null> {
  const s = loadSession();
  if (!s) return null;
  if (s.expiresAt - Date.now() > 30_000) return s.accessToken;
  if (!s.refreshToken) {
    forgetSession();
    return null;
  }
  const res = await fetch(`${base()}/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: CLIENT,
      refresh_token: s.refreshToken,
    }),
  });
  if (!res.ok) {
    forgetSession();
    return null;
  }
  save((await res.json()) as TokenResponse, s);
  return loadSession()?.accessToken ?? null;
}

/** Ends the enclave session at the identity provider too (AC-12). */
export function signOut(after = '/'): void {
  const s = loadSession();
  forgetSession();
  const url = new URL(`${base()}/logout`);
  if (s?.idToken) url.searchParams.set('id_token_hint', s.idToken);
  url.searchParams.set('post_logout_redirect_uri', `${location.origin}${after}`);
  url.searchParams.set('client_id', CLIENT);
  location.assign(url.toString());
}
