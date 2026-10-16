/**
 * Resident app shell (CHN-02, CHN-08, EQ-06/10): one small router, the
 * language, the county's name from runtime config, an offline notice, and
 * the screens. Routes carry the tenant and event (deep links from QR codes
 * and short URLs); the root forwards to the configured exercise event.
 */
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { IntlProvider, useIntl } from 'react-intl';
import {
  detectLocale,
  localeNames,
  locales,
  messages,
  type Locale,
  type MessageId,
} from './i18n/messages.ts';
import { localStore, type LocalStore } from './intake/storage.ts';
import { Outbox } from './intake/outbox.ts';
import type { RuntimeConfig } from './runtime-config.ts';
import { Welcome } from './screens/Welcome.tsx';
import { Flow } from './screens/Flow.tsx';
import { MyReport } from './screens/MyReport.tsx';
import { Resume } from './screens/Resume.tsx';
import { Help } from './screens/Help.tsx';

export interface Route {
  name: 'home' | 'welcome' | 'report' | 'kiosk' | 'resume' | 'my-report' | 'help' | 'unknown';
  tenant?: string;
  event?: string;
}

export function parseRoute(pathname: string): Route {
  const parts = pathname.replace(/\/+$/, '').split('/').filter(Boolean);
  if (parts.length === 0) return { name: 'home' };
  const [tenant, second, third] = parts;
  if (!tenant) return { name: 'home' };
  if (second === 'my-report') return { name: 'my-report', tenant };
  if (second === 'help') return { name: 'help', tenant };
  if (second && !third) return { name: 'welcome', tenant, event: second };
  if (second && third === 'report') return { name: 'report', tenant, event: second };
  if (second && third === 'kiosk') return { name: 'kiosk', tenant, event: second };
  if (second && third === 'resume') return { name: 'resume', tenant, event: second };
  return { name: 'unknown' };
}

export function useT() {
  const intl = useIntl();
  return useCallback(
    (id: MessageId, values?: Record<string, string | number>) => intl.formatMessage({ id }, values),
    [intl],
  );
}

export interface Shell {
  config: RuntimeConfig;
  locale: Locale;
  setLocale: (l: Locale) => void;
  navigate: (to: string) => void;
  store: LocalStore;
  outbox: Outbox;
  online: boolean;
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
    setPath(to);
    window.scrollTo(0, 0);
    document.getElementById('main')?.focus();
  }, []);
  return { path, navigate };
}

function useOnline() {
  const [online, setOnline] = useState(typeof navigator === 'undefined' ? true : navigator.onLine);
  useEffect(() => {
    const up = () => setOnline(true);
    const down = () => setOnline(false);
    window.addEventListener('online', up);
    window.addEventListener('offline', down);
    return () => {
      window.removeEventListener('online', up);
      window.removeEventListener('offline', down);
    };
  }, []);
  return online;
}

function Layout({ shell, children }: { shell: Shell; children: ReactNode }) {
  const t = useT();
  const county = shell.config.countyName || t('county.fallback');
  const phone = shell.config.helpPhone || t('phone.fallback');
  useEffect(() => {
    document.documentElement.lang = shell.locale;
  }, [shell.locale]);
  return (
    <>
      <a className="skip" href="#main">
        {t('skip.toContent')}
      </a>
      <header className="banner">
        <p className="agency">{t('header.agency', { county })}</p>
        <label className="lang">
          <span>{t('language.label')}</span>
          <select value={shell.locale} onChange={(e) => shell.setLocale(e.target.value as Locale)}>
            {locales.map((l) => (
              <option key={l} value={l} lang={l}>
                {localeNames[l]}
              </option>
            ))}
          </select>
        </label>
      </header>
      {!shell.online ? (
        <p className="offline" role="status">
          {t('offline.banner')}
        </p>
      ) : null}
      {children}
      <footer>
        <p>
          {t('footer.noDecision')} {t('footer.talk', { phone })}
        </p>
        {shell.config.productName ? (
          <p className="powered">{t('footer.poweredBy', { product: shell.config.productName })}</p>
        ) : null}
      </footer>
    </>
  );
}

function Screens({ shell, route }: { shell: Shell; route: Route }) {
  const t = useT();
  const phone = shell.config.helpPhone || t('phone.fallback');
  switch (route.name) {
    case 'home': {
      if (shell.config.tenant && shell.config.event)
        return <Welcome shell={shell} tenant={shell.config.tenant} event={shell.config.event} />;
      return (
        <main id="main" tabIndex={-1}>
          <section className="card safety" aria-labelledby="safety-heading">
            <h2 id="safety-heading">{t('safety.heading')}</h2>
            <p>{t('safety.body')}</p>
          </section>
          <h1>{t('intro.heading')}</h1>
          <p>{t('start.noLink', { phone })}</p>
        </main>
      );
    }
    case 'welcome':
      return <Welcome shell={shell} tenant={route.tenant!} event={route.event!} />;
    case 'report':
      return <Flow shell={shell} tenant={route.tenant!} event={route.event!} kiosk={false} />;
    case 'kiosk':
      return <Flow shell={shell} tenant={route.tenant!} event={route.event!} kiosk={true} />;
    case 'resume':
      return <Resume shell={shell} tenant={route.tenant!} event={route.event!} />;
    case 'my-report':
      return <MyReport shell={shell} tenant={route.tenant!} />;
    case 'help':
      return <Help shell={shell} />;
    default:
      return (
        <main id="main" tabIndex={-1}>
          <h1>{t('intro.heading')}</h1>
          <p>{t('start.noLink', { phone })}</p>
        </main>
      );
  }
}

export function App({ config }: { config: RuntimeConfig }) {
  const { path, navigate } = usePath();
  const route = useMemo(() => parseRoute(path), [path]);
  const [locale, setLocale] = useState<Locale>(() => {
    // CHN-08: a QR code or short link on a flyer or door hanger opens the flow in its language.
    const fromLink = new URLSearchParams(location.search).get('lang');
    if (fromLink && (locales as readonly string[]).includes(fromLink)) return fromLink as Locale;
    const saved = (() => {
      try {
        return localStorage.getItem('cg.locale');
      } catch {
        return null;
      }
    })();
    return saved && (locales as readonly string[]).includes(saved)
      ? (saved as Locale)
      : detectLocale(navigator.languages);
  });
  const online = useOnline();
  const kiosk = route.name === 'kiosk';
  const store = useMemo(() => localStore({ persistentKey: kiosk }), [kiosk]);
  const outbox = useMemo(() => new Outbox(store), [store]);
  useEffect(() => {
    void outbox.load();
  }, [outbox]);
  useEffect(() => {
    if (online) void outbox.flush();
  }, [online, outbox]);
  const setLocaleSaved = useCallback((l: Locale) => {
    setLocale(l);
    try {
      localStorage.setItem('cg.locale', l);
    } catch {
      // private mode: the choice lasts for this page only
    }
  }, []);
  const shell: Shell = {
    config,
    locale,
    setLocale: setLocaleSaved,
    navigate,
    store,
    outbox,
    online,
  };
  return (
    <IntlProvider locale={locale} messages={messages[locale]} defaultLocale="en">
      <Layout shell={shell}>
        <Screens shell={shell} route={route} />
      </Layout>
    </IntlProvider>
  );
}
