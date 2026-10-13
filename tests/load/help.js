/**
 * Public "Find help" under load (PUB-07, SCL-03, NFR-06): the endpoint every
 * channel reads, asked nearest-first by ZIP in both languages, plus the
 * GeoJSON feed the news and mapping apps poll.
 *
 *   full  — 200 requests per second for 5 minutes (a county's residents
 *           opening the page as a shelter list is announced).
 *   smoke — 10 per second for 30 seconds; runs in CI against the compose stack.
 *
 * Run:  tests/load/run.sh help [full|smoke]
 * Pass: every answer 200 with sites listed, p95 under 800 ms, no 5xx.
 */
import http from 'k6/http';
import { check } from 'k6';
import { Trend } from 'k6/metrics';
import { BASE, PROFILE, TENANT, profile } from './lib.js';

const latency = new Trend('help_latency', true);
const ZIPS = ['63001', '63002', '63003', '63004', '63005'];

export const options = {
  insecureSkipTLSVerify: true,
  scenarios: {
    help: profile(
      PROFILE,
      {
        executor: 'constant-arrival-rate',
        rate: 200,
        timeUnit: '1s',
        duration: '5m',
        preAllocatedVUs: 100,
        maxVUs: 600,
      },
      {
        executor: 'constant-arrival-rate',
        rate: 10,
        timeUnit: '1s',
        duration: '30s',
        preAllocatedVUs: 10,
        maxVUs: 50,
      },
    ),
  },
  thresholds: {
    http_req_failed: ['rate<0.01'],
    help_latency: ['p(95)<800'],
  },
};

export default function () {
  const zip = ZIPS[__ITER % ZIPS.length];
  const lang = __ITER % 4 === 0 ? 'es' : 'en';
  const res = http.get(`${BASE}/api/public/help/${TENANT}?near=${zip}&lang=${lang}`);
  latency.add(res.timings.duration);
  check(res, {
    'help answers 200': (r) => r.status === 200,
    'sites are listed': (r) => r.status === 200 && r.json('sites').length > 0,
  });
  if (__ITER % 10 === 0) {
    const geo = http.get(`${BASE}/api/public/help/${TENANT}/sites.geojson`);
    check(geo, { 'geojson answers 200': (r) => r.status === 200 });
  }
}
