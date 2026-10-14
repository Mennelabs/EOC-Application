/**
 * CJIS enclave web app (SEC-12, ADR-0038), served only by the enclave
 * gateway on its own origin; the platform console links here and never
 * fetches criminal-justice information itself.
 * - AC-8: the system use notification is shown and acknowledged before
 *   sign-in.
 * - AC-11/12: after 30 minutes without activity the app locks, hides the
 *   screen's content and ends the session; signing in again is required.
 * - Workspaces follow the enclave roles; an account that is not yet
 *   CJIS-qualified sees what is missing and nothing else.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  api,
  ApiFailure,
  describeFailure,
  missingLabel,
  setConfirmHandler,
  type Confirmation,
} from './api/client.ts';
import { beginLogin, completeLogin, forgetSession, loadSession, signOut } from './auth/oidc.ts';
import { AccountsScreen, ApprovalsScreen } from './screens/accounts.tsx';
import { AuditScreen, RetentionScreen } from './screens/audit.tsx';
import { RecordScreen, RecordsScreen } from './screens/records.tsx';
import { ConfirmDialog, label, Status } from './ui/primitives.tsx';

interface Me {
  personId: string;
  agencyName: string;
  displayName: string;
  roles: string[];
  qualified: boolean;
  missing: string[];
}

const IDLE_LIMIT_MS = 30 * 60 * 1000;

/** Tests may shorten the lock (never lengthen it): sessionStorage `cjis.idleSeconds`. */
function idleLimit(): number {
  try {
    const s = Number(sessionStorage.getItem('cjis.idleSeconds'));
    return s > 0 ? Math.min(s * 1000, IDLE_LIMIT_MS) : IDLE_LIMIT_MS;
  } catch {
    return IDLE_LIMIT_MS;
  }
}

function usePath() {
  const [path, setPath] = useState(location.pathname);
  useEffect(() => {
    const onPop = () => setPath(location.pathname);
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);
  const navigate = useCallback((to: string) => {
    history.pushState(null, '', to);
    setPath(new URL(to, location.origin).pathname);
    document.getElementById('main')?.focus();
  }, []);
  return { path, navigate };
}

function Notice({ onAccept }: { onAccept: () => void }) {
  const [text, setText] = useState<string | null>(null);
  useEffect(() => {
    fetch('/api/v1/notice')
      .then((r) => r.json() as Promise<{ text: string }>)
      .then((n) => setText(n.text))
      .catch(() =>
        setText(
          'This is a criminal justice information system. Authorized use only; all activity is recorded.',
        ),
      );
  }, []);
  return (
    <main id="main" tabIndex={-1} className="notice">
      <h1>CJIS enclave</h1>
      <h2>System use notification</h2>
      <p>{text ?? 'Loading…'}</p>
      <button type="button" className="primary" onClick={onAccept} disabled={!text}>
        I understand: sign in
      </button>
      <p className="hint">You sign in with your enclave password and your passkey.</p>
    </main>
  );
}

export function App() {
  const { path, navigate } = usePath();
  const [session, setSession] = useState(() => loadSession());
  const [me, setMe] = useState<Me | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [locked, setLocked] = useState(false);
  const [needsPasskey, setNeedsPasskey] = useState(false);
  const [confirm, setConfirm] = useState<{
    description: string;
    resolve: (c: Confirmation) => void;
  } | null>(null);
  const lastActivity = useRef(0);

  useEffect(() => {
    document.title = 'CJIS enclave';
    setConfirmHandler(
      (description) => new Promise((resolve) => setConfirm({ description, resolve })),
    );
  }, []);

  useEffect(() => {
    if (path !== '/callback') return;
    completeLogin()
      .then((to) => {
        setSession(loadSession());
        navigate(to);
      })
      .catch((e: unknown) => {
        setError(describeFailure(e));
        navigate('/');
      });
  }, [path, navigate]);

  useEffect(() => {
    if (!session) return;
    api<Me>('/me')
      .then((m) => {
        setMe(m);
        setError(null);
      })
      .catch((e: unknown) => {
        if (e instanceof ApiFailure && e.envelope.code === 'second_factor_required') {
          // The first sign-in registered the passkey; the enclave needs it on the sign-in itself.
          setNeedsPasskey(true);
          setError(null);
        } else setError(describeFailure(e));
        if ((e as { status?: number }).status === 401) {
          forgetSession();
          setSession(null);
        }
      });
  }, [session]);

  // AC-11: lock after the idle limit; the screen's content is hidden, the session ends.
  useEffect(() => {
    if (!session) return;
    lastActivity.current = Date.now();
    const touch = () => {
      lastActivity.current = Date.now();
    };
    const events = ['pointerdown', 'keydown', 'wheel', 'touchstart'] as const;
    for (const e of events) window.addEventListener(e, touch, { passive: true });
    const timer = window.setInterval(() => {
      if (Date.now() - lastActivity.current >= idleLimit()) {
        forgetSession();
        setSession(null);
        setMe(null);
        setLocked(true);
      }
    }, 1000);
    return () => {
      for (const e of events) window.removeEventListener(e, touch);
      window.clearInterval(timer);
    };
  }, [session]);

  if (path === '/callback') return <p role="status">Signing in…</p>;

  if (locked)
    return (
      <main id="main" tabIndex={-1} className="notice">
        <h1>Locked</h1>
        <p>
          The enclave locked after 30 minutes without activity and your session ended. Nothing on
          the screen is shown until you sign in again.
        </p>
        <button
          type="button"
          className="primary"
          onClick={() => {
            setLocked(false);
            void beginLogin();
          }}
        >
          Sign in again
        </button>
      </main>
    );

  if (!session && needsPasskey)
    return (
      <main id="main" tabIndex={-1} className="notice">
        <h1>Sign in with your passkey</h1>
        <p>
          Your passkey is registered. The enclave needs it on every sign-in, so please sign in once
          more: your password, then your passkey.
        </p>
        <button
          type="button"
          className="primary"
          onClick={() => {
            setNeedsPasskey(false);
            void beginLogin('/', { reauthenticate: true });
          }}
        >
          Sign in with your passkey
        </button>
      </main>
    );

  if (!session)
    return (
      <>
        {error ? <Status kind="error">{error}</Status> : null}
        <Notice onAccept={() => void beginLogin()} />
      </>
    );

  const roles = me?.roles ?? [];
  const has = (...r: string[]) => r.some((x) => roles.includes(x));
  const nav: [string, string][] = [];
  if (has('officer', 'supervisor', 'records_clerk')) nav.push(['/records', 'Records']);
  if (has('agency_admin', 'security_officer')) {
    nav.push(['/accounts', 'Accounts']);
    nav.push(['/approvals', 'Approvals']);
  }
  if (has('security_officer', 'auditor')) {
    nav.push(['/audit', 'Audit review']);
    nav.push(['/retention', 'Retention']);
  }

  let content: React.ReactNode;
  const recordMatch = /^\/records\/([A-Za-z0-9_-]{32,64})$/.exec(path);
  if (!me) content = error ? <Status kind="error">{error}</Status> : <p role="status">Loading…</p>;
  else if (!me.qualified)
    content = (
      <>
        <h1>Your enclave access is not complete</h1>
        <p>Ask your agency administrator. Missing:</p>
        <ul>
          {me.missing.map((m) => (
            <li key={m}>{missingLabel(m)}</li>
          ))}
        </ul>
      </>
    );
  else if (recordMatch?.[1])
    content = <RecordScreen key={recordMatch[1]} cjiRef={recordMatch[1]} roles={roles} />;
  else if (path === '/records') content = <RecordsScreen navigate={navigate} />;
  else if (path === '/accounts') content = <AccountsScreen me={me} />;
  else if (path === '/approvals') content = <ApprovalsScreen me={me} />;
  else if (path === '/audit') content = <AuditScreen />;
  else if (path === '/retention')
    content = <RetentionScreen canWrite={roles.includes('security_officer')} />;
  else
    content = (
      <>
        <h1>CJIS enclave</h1>
        <p>
          {me.displayName}, {me.agencyName}. Roles: {roles.map(label).join(', ')}.
        </p>
        <p>Open a record from a mission in the console, or choose a workspace.</p>
      </>
    );

  return (
    <>
      <a className="skip" href="#main">
        Skip to content
      </a>
      <header className="top">
        <p className="product">CJIS enclave</p>
        <p className="agency">{me?.agencyName ?? ''}</p>
        <button type="button" className="light" onClick={() => signOut()}>
          Sign out
        </button>
      </header>
      {nav.length > 0 ? (
        <nav aria-label="Workspaces">
          <ul>
            {nav.map(([to, text]) => (
              <li key={to}>
                <a
                  href={to}
                  aria-current={path.startsWith(to) ? 'page' : undefined}
                  onClick={(e) => {
                    e.preventDefault();
                    navigate(to);
                  }}
                >
                  {text}
                </a>
              </li>
            ))}
          </ul>
        </nav>
      ) : null}
      <main id="main" tabIndex={-1}>
        {content}
      </main>
      <ConfirmDialog
        request={confirm}
        onDone={(c) => {
          confirm?.resolve(c);
          setConfirm(null);
        }}
      />
    </>
  );
}
