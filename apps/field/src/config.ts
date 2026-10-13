/**
 * Runtime configuration (SCL-11, ADM-03). The web build reads /config.json
 * from the web container (filled from environment variables), the same file
 * the console uses; the native app reads the gateway URL from managed app
 * configuration (MDM, FLD-02) or the build's `extra`, so one build serves
 * every county. The product name is configuration, never code.
 */
import Constants from 'expo-constants';
import { Platform } from 'react-native';

export interface FieldConfig {
  /** Gateway origin, '' on the web build (same origin). */
  apiBase: string;
  productName: string;
  countyName: string;
  /** Default organization (realm) code, e.g. the county's slug. */
  tenant: string;
}

const extra = (Constants.expoConfig?.extra ?? {}) as Partial<FieldConfig>;

export async function loadConfig(): Promise<FieldConfig> {
  const base: FieldConfig = {
    apiBase: Platform.OS === 'web' ? '' : (extra.apiBase ?? ''),
    productName: extra.productName ?? '',
    countyName: extra.countyName ?? '',
    tenant: extra.tenant ?? '',
  };
  try {
    const res = await fetch(`${base.apiBase}/config.json`, { cache: 'no-store' });
    if (!res.ok) return base;
    const c = (await res.json()) as Partial<FieldConfig>;
    return {
      ...base,
      productName: c.productName || base.productName,
      countyName: c.countyName || base.countyName,
      tenant: c.tenant || base.tenant,
    };
  } catch {
    return base; // offline at start: the app still opens and works from what it holds (SCL-06)
  }
}
