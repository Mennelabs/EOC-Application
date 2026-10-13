/**
 * SCL-03 load profile: resident submissions through the public API.
 *
 *   full  — 2 × 50,000 submissions per hour: about 28 per second sustained
 *           for 20 minutes with two bursts to 60 per second (the plan's
 *           "with bursts"), measuring the acceptance rate, p95 latency and
 *           the queue depth sampled through the broker's management API.
 *   smoke — 5 per second for 30 seconds; runs in CI against the compose stack.
 *
 * Run:  tests/load/run.sh submissions [full|smoke]   (uses the k6 container)
 * Pass: every submission accepted (202) with a reference code, p95 under
 *       one second at the sustained rate, no 5xx (SCL-03, SCL-06, NFR-06).
 */
import http from 'k6/http';
import { check } from 'k6';
import { Counter, Trend } from 'k6/metrics';
import { BASE, PROFILE, TENANT, EVENT, graphInfo, profile, submission } from './lib.js';

const accepted = new Counter('submissions_accepted');
const refused = new Counter('submissions_refused');
const acceptLatency = new Trend('submission_latency', true);

export const options = {
  insecureSkipTLSVerify: true,
  scenarios: {
    submissions: profile(
      PROFILE,
      {
        executor: 'ramping-arrival-rate',
        startRate: 28,
        timeUnit: '1s',
        preAllocatedVUs: 200,
        maxVUs: 1000,
        stages: [
          { target: 28, duration: '6m' },
          { target: 60, duration: '2m' }, // burst
          { target: 28, duration: '6m' },
          { target: 60, duration: '2m' }, // burst
          { target: 28, duration: '4m' },
        ],
      },
      {
        executor: 'constant-arrival-rate',
        rate: 5,
        timeUnit: '1s',
        duration: '30s',
        preAllocatedVUs: 20,
        maxVUs: 50,
      },
    ),
  },
  thresholds: {
    http_req_failed: ['rate<0.01'],
    submission_latency: ['p(95)<1000'],
    submissions_refused: ['count==0'],
  },
};

export function setup() {
  return { graph: graphInfo() };
}

export default function (data) {
  const n = __VU * 100000 + __ITER;
  const { executionId, body } = submission(data.graph, n);
  const res = http.post(
    `${BASE}/api/public/intake/${TENANT}/${EVENT}/submissions`,
    JSON.stringify(body),
    {
      headers: { 'content-type': 'application/json', 'idempotency-key': executionId },
      tags: { name: 'submission' },
    },
  );
  acceptLatency.add(res.timings.duration);
  const ok = check(res, {
    'accepted (202)': (r) => r.status === 202,
    'reference code returned': (r) => r.status === 202 && /[A-Z]{4}-\d{4}/.test(r.body),
  });
  if (ok) accepted.add(1);
  else refused.add(1);
}
