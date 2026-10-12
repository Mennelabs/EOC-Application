import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import { ApiError, errorHandler, errors } from '../src/errors.ts';
import { parseIfMatch } from '../src/plugins/versions.ts';

function app() {
  const f = Fastify({ logger: false }).withTypeProvider<ZodTypeProvider>();
  f.setValidatorCompiler(validatorCompiler);
  f.setSerializerCompiler(serializerCompiler);
  f.setErrorHandler(errorHandler);
  f.post(
    '/things',
    { schema: { body: z.object({ name: z.string().min(2), count: z.number().int() }) } },
    async () => ({ ok: true }),
  );
  f.get('/forbidden', async () => {
    throw errors.forbidden();
  });
  f.get('/boom', async () => {
    throw new Error('database password is hunter2');
  });
  f.get('/conflict', async () => {
    throw errors.conflict({ id: 'x', version: 4 });
  });
  return f;
}

describe('error envelope (BRD:FR-00.07)', () => {
  it('validation errors name the fields and keep the input recoverable (AC-00D)', async () => {
    const res = await app().inject({
      method: 'POST',
      url: '/things',
      payload: { name: 'a', count: 1.5 },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.code).toBe('validation_failed');
    expect(body.fields.map((f: { name: string }) => f.name).sort()).toEqual(['count', 'name']);
    expect(body.requestId).toBeTruthy();
  });

  it('denials are generic (AC-C03)', async () => {
    const res = await app().inject({ url: '/forbidden' });
    expect(res.statusCode).toBe(403);
    expect(res.json().message).not.toMatch(/exist|record|id/i);
  });

  it('server errors never leak internals and are marked retryable', async () => {
    const res = await app().inject({ url: '/boom' });
    expect(res.statusCode).toBe(500);
    expect(res.body).not.toContain('hunter2');
    expect(res.json()).toMatchObject({ code: 'internal_error', retryable: true });
  });

  it('version conflicts carry the current record (AC-00B)', async () => {
    const res = await app().inject({ url: '/conflict' });
    expect(res.statusCode).toBe(409);
    expect(res.json().details).toEqual({ id: 'x', version: 4 });
  });

  it('ApiError is a plain, typed error', () => {
    const e = new ApiError(418, 'teapot', 'no');
    expect(e.status).toBe(418);
    expect(e.name).toBe('ApiError');
  });
});

describe('If-Match parsing (BRD:FR-00.05)', () => {
  it('accepts strong, weak and bare forms', () => {
    expect(parseIfMatch('"7"')).toBe(7);
    expect(parseIfMatch('W/"7"')).toBe(7);
    expect(parseIfMatch('7')).toBe(7);
    expect(parseIfMatch('abc')).toBeNull();
    expect(parseIfMatch(undefined)).toBeNull();
  });
});
