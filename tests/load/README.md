# Load profiles (SCL-03)

k6 scripts against a running stack. `smoke` runs in CI on every push; `full` is the SCL-03 target and needs a machine with the stack sized for it (the layer 2 report records the runs).

| Script         | `full`                                                                   | `smoke`          | Pass                                                     |
| -------------- | ------------------------------------------------------------------------ | ---------------- | -------------------------------------------------------- |
| `submissions`  | 28 submissions/s sustained (2 × 50,000 per hour) with two bursts to 60/s | 5/s for 30 s     | every submission accepted with a code, p95 < 1 s, no 5xx |
| `sms-sessions` | 20,000 concurrent text sessions, each walking the dialogue to a code     | 5 sessions, 30 s | every session reaches a code, reply p95 < 2 s, no 5xx    |

```
tests/load/run.sh submissions smoke
tests/load/run.sh sms-sessions smoke
BASE_URL=https://stack.example.test tests/load/run.sh submissions full
```

**One load host looks like a flood.** The abuse protection (SEC-17) refuses more than `PUBLIC_IP_DENY_PER_10MIN` submissions from one address per ten minutes (default 120) with a retryable 429, which is the right answer to a real flood and the wrong one for k6. On the stack under test set `PUBLIC_IP_DENY_PER_10MIN=100000` in `.env` before `docker compose up` (CI does this for the smoke profile), or spread the generator across addresses.

Summaries are written to `tests/load/out/<script>-<profile>.json` (git-ignored). Queue depth during a run: `docker compose exec queue rabbitmqctl list_queues name messages`. Everything sent is synthetic (SCL-12); the confirmation texts go to the simulator, never to a carrier.
