/**
 * Dependency health probes. Readiness endpoints report each dependency by name
 * so the degradation order of SCL-06 can be applied per dependency later.
 */
export interface Probe {
  readonly name: string;
  check(signal: AbortSignal): Promise<void>;
}

export interface ProbeResult {
  name: string;
  ok: boolean;
  ms: number;
  /** Short, non-sensitive reason. Never includes connection strings or secrets. */
  error?: string;
}

export async function runProbes(
  probes: readonly Probe[],
  timeoutMs = 2000,
): Promise<ProbeResult[]> {
  return Promise.all(
    probes.map(async (probe) => {
      const started = performance.now();
      const signal = AbortSignal.timeout(timeoutMs);
      try {
        await Promise.race([
          probe.check(signal),
          new Promise<never>((_, reject) =>
            signal.addEventListener('abort', () => reject(new Error('timeout')), { once: true }),
          ),
        ]);
        return { name: probe.name, ok: true, ms: Math.round(performance.now() - started) };
      } catch (err) {
        return {
          name: probe.name,
          ok: false,
          ms: Math.round(performance.now() - started),
          error: safeReason(err),
        };
      }
    }),
  );
}

/** Reduce an error to a short reason with anything URL- or credential-like removed. */
export function safeReason(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return raw
    .replace(/[a-z][a-z0-9+.-]*:\/\/\S+/gi, '<url>')
    .replace(/(password|secret|token|key)=\S+/gi, '$1=<redacted>')
    .slice(0, 120);
}

/** Probe for any HTTP health endpoint that answers 2xx when healthy. */
export function httpProbe(name: string, url: string, init?: RequestInit): Probe {
  return {
    name,
    async check(signal) {
      const res = await fetch(url, { ...init, signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    },
  };
}
