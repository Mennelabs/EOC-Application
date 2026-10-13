/**
 * SCL-03 load profile: concurrent text-message sessions through the
 * simulator webhook (the same code path as Twilio's, minus the signature).
 *
 *   full  — ramps to 20,000 concurrent sessions over 10 minutes and holds
 *           for 10; every virtual user is one phone number walking the
 *           whole numbered dialogue to a reference code, pausing like a
 *           person between replies.
 *   smoke — 5 sessions for 30 seconds; runs in CI.
 *
 * Run:  tests/load/run.sh sms-sessions [full|smoke]
 * Pass: every session reaches a reference code, reply p95 under two seconds,
 *       no 5xx (SCL-03, CHN-03).
 */
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter, Trend } from 'k6/metrics';
import { BASE, PROFILE, TENANT, profile } from './lib.js';

const completed = new Counter('sessions_completed');
const stalled = new Counter('sessions_stalled');
const replyLatency = new Trend('reply_latency', true);

export const options = {
  insecureSkipTLSVerify: true,
  scenarios: {
    sessions: profile(
      PROFILE,
      {
        executor: 'ramping-vus',
        startVUs: 0,
        stages: [
          { target: 20000, duration: '10m' },
          { target: 20000, duration: '10m' },
          { target: 0, duration: '2m' },
        ],
        gracefulRampDown: '60s',
      },
      { executor: 'constant-vus', vus: 5, duration: '30s' },
    ),
  },
  thresholds: {
    http_req_failed: ['rate<0.01'],
    reply_latency: ['p(95)<2000'],
    sessions_stalled: ['count==0'],
  },
};

function text(from, body) {
  const res = http.post(
    `${BASE}/api/webhooks/simulator/sms`,
    JSON.stringify({ from, tenant: TENANT, body }),
    { headers: { 'content-type': 'application/json' }, tags: { name: 'sms' } },
  );
  replyLatency.add(res.timings.duration);
  check(res, { 'reply (200)': (r) => r.status === 200 });
  if (res.status !== 200) return [];
  return res.json().replies || [];
}

/** Answer whatever the county asked, as a person on a phone would. */
function answer(prompt, n) {
  if (prompt.includes('Where is the home'))
    return `${100 + (n % 9000)} Load Test Ln, Westwind 63001`;
  if (prompt.includes('What is your name')) return `Load Tester ${n}`;
  if (prompt.includes('own words')) return 'Shingles came off and water got into the kitchen.';
  if (prompt.includes('photos')) return 'skip';
  if (prompt.includes('Do you need help')) return n % 7 === 0 ? '1' : 'skip';
  if (/^1 /m.test(prompt) || prompt.includes('Reply with a number')) return '1';
  return 'skip';
}

export default function () {
  const n = __VU * 1000 + __ITER;
  // One number per session; the pool is reused across iterations, which is what repeat callers do.
  const from = `+1314${String(2000000 + ((__VU * 7919 + __ITER) % 7999999)).padStart(7, '0')}`;
  const pace = PROFILE === 'full' ? () => sleep(2 + Math.random() * 4) : () => sleep(0.1);
  let replies = text(from, 'DAMAGE');
  for (let step = 0; step < 40; step++) {
    const last = replies[replies.length - 1] || '';
    if (/[A-Z]{4}-\d{4}/.test(last)) {
      completed.add(1);
      text(from, 'STOP'); // leaves the number clean for the next session
      return;
    }
    if (last.includes('SEND')) {
      replies = text(from, 'send');
      continue;
    }
    pace();
    replies = text(from, answer(last, n));
  }
  stalled.add(1);
}
