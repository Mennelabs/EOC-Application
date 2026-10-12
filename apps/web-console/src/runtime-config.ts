/**
 * Runtime configuration served by the web container from environment
 * variables (/config.json), so one build runs in every environment (SCL-11).
 * ADM-03: the product name is configuration; residents see the county's name.
 */
export interface RuntimeConfig {
  productName: string;
  countyName: string;
  helpPhone: string;
}

const fallback: RuntimeConfig = { productName: '', countyName: '', helpPhone: '' };

export async function loadRuntimeConfig(): Promise<RuntimeConfig> {
  try {
    const res = await fetch('/config.json', { cache: 'no-store' });
    if (!res.ok) return fallback;
    return { ...fallback, ...((await res.json()) as Partial<RuntimeConfig>) };
  } catch {
    return fallback; // Degrade quietly: the page still works without it (SCL-06).
  }
}
