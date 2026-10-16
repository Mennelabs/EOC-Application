/**
 * The published questions for a tenant's event, cached on the device so the
 * flow starts offline, with the shipped graph as the last resort (SCL-06).
 * The graph is public; it is kept in clear.
 */
import { useEffect, useState } from 'react';
import { westwindGraph } from '@cg/intake';
import { getIntake, type IntakeInfo } from '../api/public.ts';
import { brandFrom, brandStore } from '../intake/brand.ts';

const key = (tenant: string, event: string) => `cg.graph.${tenant}.${event}`;

export function cachedIntake(tenant: string, event: string): IntakeInfo | null {
  try {
    const raw = localStorage.getItem(key(tenant, event));
    return raw ? (JSON.parse(raw) as IntakeInfo) : null;
  } catch {
    return null;
  }
}

export function fallbackIntake(tenant: string, event: string): IntakeInfo {
  return {
    tenant: { slug: tenant, name: '', branding: {} },
    event: { id: '', name: event, hazardType: 'other', hazards: ['other'], keywords: [] },
    languages: westwindGraph.languages,
    helpPhone: null,
    sms: { termsUrl: null, privacyUrl: null },
    graph: westwindGraph,
    uploads: { enabled: false },
  };
}

export function useIntake(tenant: string, event: string, lang: string) {
  const [data, setData] = useState<IntakeInfo | null>(() => cachedIntake(tenant, event));
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(!data);
  // ADM-01: the page frame shows the county's branding once the page is known.
  useEffect(() => {
    if (data?.tenant.name) brandStore.set(brandFrom(data));
  }, [data]);
  useEffect(() => {
    let alive = true;
    getIntake(tenant, event, lang)
      .then((info) => {
        if (!alive) return;
        setData(info);
        setError(null);
        try {
          localStorage.setItem(key(tenant, event), JSON.stringify(info));
        } catch {
          // no cache: the next load fetches again
        }
      })
      .catch((err: unknown) => {
        if (!alive) return;
        setError(err instanceof Error ? err.message : 'load_failed');
        setData((d) => d ?? cachedIntake(tenant, event));
      })
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [tenant, event, lang]);
  return { data, error, loading };
}
