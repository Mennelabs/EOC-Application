/**
 * Welcome (plan screen 1; INT-07, CON-10, EQ-10, CHN-08, WIT-01, HLP-01):
 * the county, the language in its own script, the 911 line first, what to
 * expect, and the ways in: own home, helping someone, saw damage, my report,
 * continue a paused report.
 */
import { useEffect } from 'react';
import type { Shell } from '../App.tsx';
import { useT } from '../App.tsx';
import { useIntake } from './useIntake.ts';

export function Welcome({ shell, tenant, event }: { shell: Shell; tenant: string; event: string }) {
  const t = useT();
  const county = shell.config.countyName || t('county.fallback');
  const info = useIntake(tenant, event, shell.locale);
  useEffect(() => {
    document.title = t('page.title', { county: info.data?.tenant.name ?? county });
  }, [t, county, info.data]);
  const base = `/${tenant}/${event}`;
  const start = (rel: 'own_home' | 'helper' | 'witness') => () => {
    try {
      sessionStorage.setItem('cg.start', JSON.stringify({ rel, at: Date.now() }));
    } catch {
      // without storage the flow asks who is reporting
    }
    shell.navigate(`${base}/report`);
  };
  return (
    <main id="main" tabIndex={-1}>
      <section className="card safety" aria-labelledby="safety-heading">
        <h2 id="safety-heading">{t('safety.heading')}</h2>
        <p>{t('safety.body')}</p>
      </section>
      <h1>{t('intro.heading')}</h1>
      {info.data ? <p>{t('intro.event', { event: info.data.event.name })}</p> : null}
      <p>{t('intro.body')}</p>
      <ul className="facts">
        <li>{t('facts.time')}</li>
        <li>{t('facts.noAccount')}</li>
        <li>{t('facts.everyone')}</li>
      </ul>
      <div className="buttons stack">
        <button type="button" className="primary" onClick={start('own_home')}>
          {t('start.button')}
        </button>
        <button type="button" onClick={start('helper')}>
          {t('start.helper')}
        </button>
        <button type="button" onClick={start('witness')}>
          {t('start.witness')}
        </button>
      </div>
      <p>
        <a
          href={`/${tenant}/my-report`}
          onClick={(e) => (e.preventDefault(), shell.navigate(`/${tenant}/my-report`))}
        >
          {t('start.myReport')}
        </a>
      </p>
      <p>
        <a
          href={`${base}/resume`}
          onClick={(e) => (e.preventDefault(), shell.navigate(`${base}/resume`))}
        >
          {t('start.resume')}
        </a>
      </p>
      {info.error ? (
        <p role="status" className="hint">
          {t('error.load')}
        </p>
      ) : null}
    </main>
  );
}
