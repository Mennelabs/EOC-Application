import { useEffect, useState } from 'react';
import { IntlProvider, FormattedMessage, useIntl } from 'react-intl';
import { detectLocale, localeNames, locales, messages, type Locale } from './i18n/messages.ts';
import type { RuntimeConfig } from './runtime-config.ts';

function Welcome({
  config,
  locale,
  onLocale,
}: {
  config: RuntimeConfig;
  locale: Locale;
  onLocale: (l: Locale) => void;
}) {
  const intl = useIntl();
  const [notice, setNotice] = useState(false);
  const county = config.countyName || intl.formatMessage({ id: 'county.fallback' });
  const phone = config.helpPhone || intl.formatMessage({ id: 'phone.fallback' });

  useEffect(() => {
    document.title = intl.formatMessage({ id: 'page.title' }, { county });
    document.documentElement.lang = locale;
  }, [intl, county, locale]);

  return (
    <>
      <header className="banner">
        <p className="agency">
          <FormattedMessage id="header.agency" values={{ county }} />
        </p>
        <label className="lang">
          <span>
            <FormattedMessage id="language.label" />
          </span>
          <select value={locale} onChange={(e) => onLocale(e.target.value as Locale)}>
            {locales.map((l) => (
              <option key={l} value={l} lang={l}>
                {localeNames[l]}
              </option>
            ))}
          </select>
        </label>
      </header>

      <main id="main">
        {/* INT-07 / CON-10: safety first, 911 instruction before anything else. */}
        <section className="safety" aria-labelledby="safety-heading">
          <h2 id="safety-heading">
            <FormattedMessage id="safety.heading" />
          </h2>
          <p>
            <FormattedMessage id="safety.body" />
          </p>
        </section>

        <h1>
          <FormattedMessage id="intro.heading" />
        </h1>
        <p>
          <FormattedMessage id="intro.body" />
        </p>
        <ul className="facts">
          <li>
            <FormattedMessage id="facts.time" />
          </li>
          <li>
            <FormattedMessage id="facts.noAccount" />
          </li>
          <li>
            <FormattedMessage id="facts.everyone" />
          </li>
        </ul>

        <button type="button" className="primary" onClick={() => setNotice(true)}>
          <FormattedMessage id="start.button" />
        </button>
        <p role="status" className="notice">
          {notice ? <FormattedMessage id="start.notYet" values={{ phone }} /> : null}
        </p>
      </main>

      <footer>
        <p>
          <FormattedMessage id="footer.noDecision" />{' '}
          <FormattedMessage id="footer.talk" values={{ phone }} />
        </p>
        {config.productName ? (
          <p className="powered">
            <FormattedMessage id="footer.poweredBy" values={{ product: config.productName }} />
          </p>
        ) : null}
      </footer>
    </>
  );
}

export function App({ config }: { config: RuntimeConfig }) {
  const [locale, setLocale] = useState<Locale>(() => detectLocale(navigator.languages));
  return (
    <IntlProvider locale={locale} messages={messages[locale]} defaultLocale="en">
      <Welcome config={config} locale={locale} onLocale={setLocale} />
    </IntlProvider>
  );
}
