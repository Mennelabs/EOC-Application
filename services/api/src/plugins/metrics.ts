/**
 * API metrics (NFR-10, ADR-0023): every request by its route template,
 * method and status class with its latency; refusals and failures by error
 * code (version_conflict is a save conflict, BRD:FR-00.05); requests answered
 * from an earlier identical one (duplicate prevention, BRD:FR-00.06); field
 * command results (FLD-13); AI calls by feature and outcome (AI-10). Served
 * at /metrics on the API's own port, which the gateway never routes to; the
 * labels never carry an id or anything a person wrote.
 */
import type { FastifyPluginAsync } from 'fastify';
import fp from 'fastify-plugin';
import { METRICS_CONTENT_TYPE, Registry } from '@cg/adapters';

export const apiMetrics = new Registry();
const requests = apiMetrics.counter(
  'cg_http_requests_total',
  'API requests by route template, method and status class',
);
const latency = apiMetrics.histogram(
  'cg_http_request_duration_seconds',
  'API request latency in seconds by route template and method',
);
export const apiErrors = apiMetrics.counter(
  'cg_api_errors_total',
  'Refusals and failures by error code (version_conflict = save conflict)',
);
const replays = apiMetrics.counter(
  'cg_idempotent_replays_total',
  'Requests answered from an earlier identical request (duplicates prevented)',
);
export const fieldCommandResults = apiMetrics.counter(
  'cg_field_commands_total',
  'Commands from phones by kind and result (applied, duplicate, conflict, rejected)',
);
export const aiCalls = apiMetrics.counter(
  'cg_ai_calls_total',
  'AI calls by feature and outcome (ok, filtered, invalid, refused, timeout, error)',
);

export const metricsPlugin: FastifyPluginAsync = fp(async (app) => {
  app.addHook('onResponse', async (request, reply) => {
    const route = request.routeOptions.url ?? 'unmatched';
    if (route === '/metrics') return;
    const method = request.method;
    requests.inc({ route, method, status: `${Math.floor(reply.statusCode / 100)}xx` });
    latency.observe(reply.elapsedTime / 1000, { route, method });
    if (reply.getHeader('idempotency-replayed') === 'true') replays.inc({ route });
  });
  app.get('/metrics', { schema: { hide: true } }, async (_request, reply) =>
    reply.header('content-type', METRICS_CONTENT_TYPE).send(apiMetrics.expose()),
  );
});
