# Load profiles (SCL-03)

k6 scripts against a running stack. `smoke` runs in CI on every push; `full` is the SCL-03 target and needs a machine with the stack sized for it (the layer 2 report records the runs).

| Script         | `full`                                                                                      | `smoke`          | Pass                                                     |
| -------------- | ------------------------------------------------------------------------------------------- | ---------------- | -------------------------------------------------------- |
| `submissions`  | 28 submissions/s sustained (2 × 50,000 per hour) with two bursts to 60/s                    | 5/s for 30 s     | every submission accepted with a code, p95 < 1 s, no 5xx |
| `sms-sessions` | 20,000 concurrent text sessions, each walking the dialogue to a code                        | 5 sessions, 30 s | every session reaches a code, reply p95 < 2 s, no 5xx    |
| `help`         | 200 "Find help" requests/s by ZIP in both languages, plus the GeoJSON feed                  | 10/s for 30 s    | every answer 200 with sites, p95 < 800 ms, no 5xx        |
| `field`        | 100 position batches/s for 5 min with 300 dispatch screens on the stream                    | 10/s, 20 readers | every batch 202, p95 < 1 s; every stream ready < 2 s     |
| `generation`   | 50,000 synthetic reports in one event: counting rule, IDA package (PDF and zip) and metrics | 1,000 reports    | each step under 60 s (`full`) or 15 s (`smoke`)          |

```
tests/load/run.sh submissions smoke
tests/load/run.sh sms-sessions smoke
tests/load/run.sh help smoke
tests/load/run.sh field smoke
BASE_URL=https://stack.example.test tests/load/run.sh submissions full
API_DB_TEST_APP_URL=… API_DB_TEST_WORKER_URL=… pnpm --filter @cg/worker load:generation smoke
```

`generation` is not a k6 script: it times the official numbers in-process against the stack's database (`services/worker/scripts/generation-load.ts`), with the app and worker database roles the API and worker use, in its own exercise county that it closes afterwards.

**One load host looks like a flood.** The abuse protection (SEC-17) refuses more than `PUBLIC_IP_DENY_PER_10MIN` submissions from one address per ten minutes (default 120) with a retryable 429, which is the right answer to a real flood and the wrong one for k6. On the stack under test set `PUBLIC_IP_DENY_PER_10MIN=100000` in `.env` before `docker compose up` (CI does this for the smoke profile), or spread the generator across addresses.

Summaries are written to `tests/load/out/<script>-<profile>.json` (git-ignored). Queue depth during a run: `docker compose exec queue rabbitmqctl list_queues name messages`. Everything sent is synthetic (SCL-12); the confirmation texts go to the simulator, never to a carrier.
