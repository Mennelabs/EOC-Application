/**
 * Shared pieces for the k6 profiles (SCL-03). k6 runs these files, not Node:
 * imports are k6 modules and the environment comes from __ENV.
 */
import http from 'k6/http';

export const BASE = __ENV.BASE_URL || 'https://localhost';
export const TENANT = __ENV.TENANT || 'county';
export const EVENT = __ENV.EVENT || 'westwind';
export const PROFILE = __ENV.PROFILE || 'smoke';

/** Arrival-rate and duration per profile; `full` is the SCL-03 target, `smoke` runs in CI. */
export function profile(name, full, smoke) {
  return name === 'full' ? full : smoke;
}

export function graphInfo() {
  const res = http.get(`${BASE}/api/public/intake/${TENANT}/${EVENT}`);
  if (res.status !== 200) throw new Error(`graph: ${res.status} ${res.body}`);
  const body = res.json();
  return { key: body.graph.key, version: body.graph.version };
}

export function uuid() {
  // RFC 4122 v4 from k6's Math.random; uniqueness per run is what matters here.
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

/** One realistic own-home submission; the address varies so duplicate flags stay rare. */
export function submission(graph, n) {
  const executionId = uuid();
  return {
    executionId,
    body: {
      executionId,
      channel: 'web',
      language: n % 5 === 0 ? 'es' : 'en',
      graphKey: graph.key,
      graphVersion: graph.version,
      relationship: 'own_home',
      answers: {
        danger_now: { kind: 'value', value: 'no' },
        relationship: { kind: 'value', value: 'own_home' },
        address: {
          kind: 'value',
          value: { line1: `${100 + (n % 9000)} Load Test Ln`, city: 'Westwind', postal: '63001' },
        },
        home_type: { kind: 'value', value: n % 3 === 0 ? 'mobile_manufactured' : 'house' },
        cause: { kind: 'value', value: 'wind_tornado' },
        damage_types: { kind: 'value', value: n % 2 === 0 ? ['roof'] : ['roof', 'windows_doors'] },
        roof_state: { kind: 'value', value: n % 4 === 0 ? 'large_hole' : 'some_missing' },
        habitable: { kind: 'value', value: n % 7 === 0 ? 'no' : 'yes' },
        tonight: { kind: 'value', value: n % 7 === 0 ? 'yes' : 'no' },
        insurance: { kind: 'unknown' },
        contact_name: { kind: 'value', value: `Load Tester ${n}` },
        contact: {
          kind: 'value',
          value: { phone: `314555${String(1000 + (n % 9000))}`, preferred: 'text' },
        },
      },
      needs: n % 7 === 0 ? ['shelter_tonight'] : [],
      consent: {},
    },
  };
}
