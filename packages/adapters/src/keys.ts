/**
 * Keys adapter (ADR-0009). Scaffold level: health of the key service.
 * Envelope encryption with per-tenant keys is built in layer 1 (SEC-10).
 */
import type { Probe } from './health.ts';

/** OpenBao answers 200 on /v1/sys/health only when initialised, unsealed and active. */
export function openBaoProbe(name: string, addr: string): Probe {
  return {
    name,
    async check(signal) {
      const res = await fetch(new URL('/v1/sys/health', addr), { signal });
      if (res.status !== 200) throw new Error(`OpenBao not ready (HTTP ${res.status})`);
    },
  };
}
