/**
 * Typed configuration. Configuration comes only from environment variables and
 * secrets, never from code (SCL-11). Every service calls `loadConfig` once at
 * start-up and fails fast with a readable message when something is missing.
 */
import { z } from 'zod';

const url = z.url();

/** Settings shared by every service. */
export const baseSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  /** ADM-03: the product names itself only through this value. */
  PRODUCT_NAME: z.string().min(1),
  PORT: z.coerce.number().int().positive().default(8080),
  /** SCL-12: refuse to start against anything but synthetic data on a laptop. */
  DATA_CLASSIFICATION_MODE: z.enum(['synthetic', 'production']).default('synthetic'),
});

/** Platform API and worker. */
export const platformSchema = baseSchema.extend({
  DATABASE_URL: url,
  AMQP_URL: url,
  S3_ENDPOINT: url,
  S3_REGION: z.string().default('us-east-1'),
  S3_ACCESS_KEY_ID: z.string().min(1),
  S3_SECRET_ACCESS_KEY: z.string().min(8),
  S3_BUCKET: z.string().min(3),
  KEYS_PROVIDER: z.enum(['openbao']).default('openbao'),
  OPENBAO_ADDR: url,
  OPENBAO_TOKEN_FILE: z.string().min(1),
  IDP_ISSUER_URL: url,
  IDP_HEALTH_URL: url,
  SMTP_URL: url,
});

/** CJIS enclave API (SEC-12): its own database and keys, nothing shared. */
export const cjisSchema = baseSchema.extend({
  CJIS_DATABASE_URL: url,
  CJIS_OPENBAO_ADDR: url,
});

export type BaseConfig = z.infer<typeof baseSchema>;
export type PlatformConfig = z.infer<typeof platformSchema>;
export type CjisConfig = z.infer<typeof cjisSchema>;

export class ConfigError extends Error {
  override readonly name = 'ConfigError';
}

export function loadConfig<S extends z.ZodType>(
  schema: S,
  env: Record<string, string | undefined> = process.env,
): z.infer<S> {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    // List variable names only: values may be secrets (CLAUDE.md rule 9).
    const names = [...new Set(parsed.error.issues.map((i) => i.path.join('.')))];
    throw new ConfigError(`Invalid or missing configuration: ${names.join(', ')}`);
  }
  return parsed.data;
}
