/**
 * Optimistic concurrency (BRD:FR-00.05, AC-00B). Every record carries a
 * `version`; updates send it back in `If-Match`. A stale version gets 409
 * with the current record so the client can show what changed and keep the
 * user's input. Routes opt in with `config: { requiresVersion: true }`.
 */
import fp from 'fastify-plugin';
import type { FastifyRequest } from 'fastify';
import { errors } from '../errors.ts';

declare module 'fastify' {
  interface FastifyContextConfig {
    requiresVersion?: boolean;
  }
  interface FastifyRequest {
    expectedVersion(): number;
  }
}

export function parseIfMatch(header: string | string[] | undefined): number | null {
  if (typeof header !== 'string') return null;
  const m = /^(?:W\/)?"?(\d+)"?$/.exec(header.trim());
  return m?.[1] ? Number(m[1]) : null;
}

export const versionsPlugin = fp(
  async (app) => {
    app.decorateRequest('expectedVersion', function (this: FastifyRequest) {
      const v = parseIfMatch(this.headers['if-match']);
      if (v === null) throw errors.versionRequired();
      return v;
    });

    app.addHook('preHandler', async (request) => {
      if (request.routeOptions.config.requiresVersion) request.expectedVersion();
    });
  },
  { name: 'cg-versions' },
);

/** Throw the standard conflict when an update matched zero rows. */
export function assertUpdated<T>(updated: T | undefined, current: unknown): T {
  if (updated === undefined) throw errors.conflict(current);
  return updated;
}
