/**
 * Field traffic under load (layer-4 plan §9; DSP-08, NFR-07, SCL-03): phones
 * sending position batches while dispatch screens hold the live stream open.
 *
 *   full  — 100 position batches per second (about 3,000 responders sending
 *           every 30 seconds) for 5 minutes, with 300 dispatch screens on the
 *           stream.
 *   smoke — 10 batches per second for 30 seconds and 20 stream readers;
 *           runs in CI against the compose stack.
 *
 * The phone is the seeded field lead (Field Exercise Team, synthetic,
 * SCL-12), checked in for the run and checked out after it. Tokens come from
 * the development test client.
 *
 * Run:  tests/load/run.sh field [full|smoke]
 * Pass: every batch 202, batch p95 under 1 s, every stream 200 and ready
 *       within 2 s, no 5xx.
 */
import http from 'k6/http';
import { check } from 'k6';
import { Trend } from 'k6/metrics';
import { BASE, PROFILE, profile } from './lib.js';

const batchLatency = new Trend('position_batch_latency', true);
const streamReady = new Trend('stream_ready', true);
const PASSWORD = 'Westwind-Exercise-2026!';
const HOLD_MS = PROFILE === 'full' ? 60000 : 10000;

export const options = {
  insecureSkipTLSVerify: true,
  setupTimeout: '60s',
  scenarios: {
    positions: profile(
      PROFILE,
      {
        executor: 'constant-arrival-rate',
        exec: 'positions',
        rate: 100,
        timeUnit: '1s',
        duration: '5m',
        preAllocatedVUs: 50,
        maxVUs: 300,
      },
      {
        executor: 'constant-arrival-rate',
        exec: 'positions',
        rate: 10,
        timeUnit: '1s',
        duration: '30s',
        preAllocatedVUs: 10,
        maxVUs: 40,
      },
    ),
    stream: profile(
      PROFILE,
      { executor: 'constant-vus', exec: 'stream', vus: 300, duration: '5m' },
      { executor: 'constant-vus', exec: 'stream', vus: 20, duration: '30s' },
    ),
  },
  thresholds: {
    'checks{scenario:positions}': ['rate==1'],
    'checks{scenario:stream}': ['rate==1'],
    position_batch_latency: ['p(95)<1000'],
    stream_ready: ['p(95)<2000'],
  },
};

function token(realm, user) {
  const res = http.post(`${BASE}/auth/realms/${realm}/protocol/openid-connect/token`, {
    grant_type: 'password',
    client_id: 'cg-tests',
    client_secret: 'cg-tests-dev-secret',
    username: user,
    password: PASSWORD,
  });
  if (res.status !== 200) throw new Error(`token for ${user}: ${res.status} ${res.body}`);
  return res.json('access_token');
}

const json = (tok) => ({
  headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' },
});

export function setup() {
  const field = token('county', 'rowan.field@example.org');
  const dispatch = token('county', 'priya.assessment@example.org');
  // A shift left open by an earlier suite ends first; then the run's own shift.
  const mine = http.get(`${BASE}/api/v1/check-ins?mine=true`, json(field));
  for (const c of mine.json() || [])
    if (!c.endedAt)
      http.post(`${BASE}/api/v1/check-ins/${c.id}/end`, '{"reason":"checked_out"}', json(field));
  const started = http.post(`${BASE}/api/v1/check-ins`, '{"eventCode":"westwind"}', json(field));
  if (started.status !== 201) throw new Error(`check-in: ${started.status} ${started.body}`);
  return { field, dispatch, checkInId: started.json('id') };
}

export function positions(data) {
  const now = Date.now();
  const fixes = [];
  for (let i = 4; i >= 0; i--)
    fixes.push({
      lat: 38.79 + Math.random() * 0.02,
      lon: -90.88 + Math.random() * 0.02,
      accuracyM: 8,
      recordedAt: new Date(now - i * 6000).toISOString(),
    });
  const res = http.post(
    `${BASE}/api/v1/positions`,
    JSON.stringify({ positions: fixes }),
    json(data.field),
  );
  batchLatency.add(res.timings.duration);
  check(res, { 'batch accepted (202)': (r) => r.status === 202 });
}

export function stream(data) {
  const res = http.get(`${BASE}/api/v1/stream?maxMs=${HOLD_MS}`, {
    headers: { authorization: `Bearer ${data.dispatch}`, accept: 'text/event-stream' },
    timeout: `${HOLD_MS + 30000}ms`,
  });
  // Time to first byte is when the screen is live (the ready frame comes first).
  streamReady.add(res.timings.waiting);
  check(res, {
    'stream 200': (r) => r.status === 200,
    'stream ready': (r) => typeof r.body === 'string' && r.body.includes('event: ready'),
  });
}

export function teardown(data) {
  http.post(
    `${BASE}/api/v1/check-ins/${data.checkInId}/end`,
    '{"reason":"checked_out"}',
    json(data.field),
  );
}
