/**
 * One error envelope for every route (BRD:FR-00.07): a stable code, a plain
 * message, field-level details for validation, whether a retry is safe, and
 * the request id for support. Denials say nothing about whether the record
 * exists (AC-C03).
 */
import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';
import { hasZodFastifySchemaValidationErrors } from 'fastify-type-provider-zod';
import { apiErrors } from './plugins/metrics.ts';

export interface FieldError {
  name: string;
  message: string;
}

export interface ApiErrorOptions {
  fields?: FieldError[];
  retryable?: boolean;
  details?: unknown;
}

export class ApiError extends Error {
  override readonly name = 'ApiError';
  readonly status: number;
  readonly code: string;
  readonly options: ApiErrorOptions;
  constructor(status: number, code: string, message: string, options: ApiErrorOptions = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.options = options;
  }
}

export const errors = {
  unauthorized: (code = 'unauthorized') => new ApiError(401, code, 'Sign in to continue.'),
  forbidden: () => new ApiError(403, 'forbidden', 'You do not have permission for this action.'),
  notFound: () => new ApiError(404, 'not_found', 'Not found.'),
  conflict: (current: unknown) =>
    new ApiError(409, 'version_conflict', 'This record changed since you loaded it.', {
      details: current,
    }),
  inProgress: () =>
    new ApiError(409, 'request_in_progress', 'The same request is still being processed.', {
      retryable: true,
    }),
  idempotencyMismatch: () =>
    new ApiError(
      422,
      'idempotency_key_reused',
      'This Idempotency-Key was used for a different request.',
    ),
  confirmationRequired: (action: string, description: string) =>
    new ApiError(
      428,
      'confirmation_required',
      `"${description}" needs confirmation and a reason.`,
      {
        details: { action, headers: ['X-Confirm: true', 'X-Reason: <why>'] },
      },
    ),
  versionRequired: () =>
    new ApiError(428, 'version_required', 'Send If-Match with the record version you loaded.'),
  idempotencyKeyRequired: () =>
    new ApiError(400, 'idempotency_key_required', 'Send an Idempotency-Key header (UUID).'),
  validation: (fields: FieldError[]) =>
    new ApiError(400, 'validation_failed', 'Some values need attention.', { fields }),
};

export function errorHandler(
  error: FastifyError | ApiError | Error,
  request: FastifyRequest,
  reply: FastifyReply,
): void {
  if (error instanceof ApiError) {
    apiErrors.inc({ code: error.code });
    reply.code(error.status).send({
      code: error.code,
      message: error.message,
      fields: error.options.fields ?? [],
      retryable: error.options.retryable ?? false,
      details: error.options.details,
      requestId: request.id,
    });
    return;
  }
  if (hasZodFastifySchemaValidationErrors(error)) {
    apiErrors.inc({ code: 'validation_failed' });
    reply.code(400).send({
      code: 'validation_failed',
      message: 'Some values need attention.',
      fields: error.validation.map((v) => ({
        name:
          v.instancePath.replace(/^\//, '').replace(/\//g, '.') ||
          ((v.params as { issue?: { path?: PropertyKey[] } }).issue?.path ?? [])
            .map(String)
            .join('.'),
        message: v.message ?? 'invalid',
      })),
      retryable: false,
      requestId: request.id,
    });
    return;
  }
  const status =
    'statusCode' in error && typeof error.statusCode === 'number' ? error.statusCode : 500;
  if (status >= 500) request.log.error({ err: error }, 'unhandled error');
  apiErrors.inc({ code: status >= 500 ? 'internal_error' : 'error' });
  reply.code(status).send({
    code: status >= 500 ? 'internal_error' : ('code' in error && error.code) || 'error',
    message:
      status >= 500 ? 'Something went wrong on our side. Your input was not lost.' : error.message,
    fields: [],
    retryable: status >= 500,
    requestId: request.id,
  });
}
