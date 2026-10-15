/**
 * Typed configuration. Configuration comes only from environment variables and
 * secrets, never from code (SCL-11). Every service calls `loadConfig` once at
 * start-up and fails fast with a readable message when something is missing.
 */
import { z } from 'zod';

const url = z.url();
/** Compose passes unset variables as empty strings; treat those as absent. */
const optionalString = z.preprocess(
  (v) => (v === '' ? undefined : v),
  z.string().min(1).optional(),
);

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
  /**
   * Bucket with object lock for records that never change: issued official reports and audit
   * anchors (ADR-0010, RULE-10). The worker creates it with object lock on; `<S3_BUCKET>-records`
   * when not set.
   */
  S3_RECORDS_BUCKET: z.preprocess((v) => (v === '' ? undefined : v), z.string().min(3).optional()),
  /** COMPLIANCE: nobody can shorten or lift a lock, not even the storage account's root. */
  S3_LOCK_MODE: z.enum(['GOVERNANCE', 'COMPLIANCE']).default('COMPLIANCE'),
  /** Where browsers reach object storage for direct uploads (SCL-04); absent means the internal endpoint. */
  S3_PUBLIC_ENDPOINT: z.preprocess((v) => (v === '' ? undefined : v), url.optional()),
  KEYS_PROVIDER: z.enum(['openbao']).default('openbao'),
  OPENBAO_ADDR: url,
  OPENBAO_TOKEN_FILE: z.string().min(1),
  /** Keycloak as the API reaches it (JWKS fetch), e.g. http://idp:8080/auth */
  IDP_INTERNAL_BASE: url,
  /** Keycloak as browsers see it; token issuers start with this, e.g. https://localhost/auth */
  IDP_PUBLIC_BASE: url,
  IDP_HEALTH_URL: url,
  SMTP_URL: url,
  /** Signs resident tokens issued after reference code + one-time code (SEC-09); never in code. */
  RESIDENT_TOKEN_SECRET: z.string().min(32),
  /** Twilio account for real numbers (docs/06); empty or absent means the simulator (SCL-11 stand-in). */
  TWILIO_ACCOUNT_SID: optionalString,
  TWILIO_AUTH_TOKEN: optionalString,
  /** The URL Twilio was given for webhooks, when it differs from what the gateway reports (signature check). */
  WEBHOOK_PUBLIC_BASE: z.preprocess((v) => (v === '' ? undefined : v), url.optional()),
  /** Largest photo a resident may upload after client-side compression (PHO-05). */
  PUBLIC_UPLOAD_MAX_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .default(6 * 1024 * 1024),
  /**
   * Abuse protection (SEC-17): public submissions from one address per ten
   * minutes before a verification flag, and before a retryable 429. A load
   * generator on a single host needs the deny limit raised (tests/load).
   */
  PUBLIC_IP_VERIFY_PER_10MIN: z.coerce.number().int().positive().default(20),
  PUBLIC_IP_DENY_PER_10MIN: z.coerce.number().int().positive().default(120),
  /**
   * Where browsers reach the CJIS enclave (SEC-12, ADR-0038). The platform
   * only links there; it never calls the enclave. Absent: no link is shown.
   */
  CJIS_PUBLIC_URL: z.preprocess((v) => (v === '' ? undefined : v), url.optional()),
  /**
   * OpenAI for every AI function (ADR-0043, decided 2026-10-15). A secret: set in the
   * environment's secrets, never in the repository or a log. Absent means every AI feature is
   * off and the manual paths run; there is no fake provider in a running system.
   */
  OPENAI_API_KEY: optionalString,
  /** A government-cloud or proxy endpoint for the same API; OpenAI's own by default. */
  OPENAI_BASE_URL: z.preprocess((v) => (v === '' ? undefined : v), url.optional()),
  OPENAI_ORGANIZATION: optionalString,
  /** Model per function; configuration, not code (ADR-0043). Defaults in packages/ai. */
  AI_MODEL_TEXT: optionalString,
  AI_MODEL_VISION: optionalString,
  AI_MODEL_CLASSIFIER: optionalString,
  AI_MODEL_TRANSCRIPTION: optionalString,
  AI_MODEL_SPEECH: optionalString,
  /** Per call (BRD:INT-04); a timeout falls back to the manual path (AI-10). */
  AI_TIMEOUT_MS: z.coerce.number().int().positive().default(20_000),
});

/** Worker: platform settings plus identity-provider administration and mail. */
export const workerSchema = platformSchema
  .extend({
    KC_ADMIN_USER: z.string().min(1),
    KC_ADMIN_PASSWORD: z.string().min(8),
    /** Where browsers reach the gateway, for realm redirect URIs and emails. */
    GATEWAY_PUBLIC_URL: url,
    MAIL_FROM: z.string().min(3).default('no-reply@localhost'),
    /** Development only: realms get a confidential test client with direct-access grants. */
    IDP_DEV_DIRECT_GRANT: z
      .enum(['true', 'false'])
      .default('false')
      .transform((v) => v === 'true'),
    /**
     * Reference data (ADR-0039, SCL-12): `recorded` replays the synthetic WESTWIND
     * responses shipped with the code (development and CI), `live` calls the free
     * federal sources, `off` pulls nothing (file imports still work).
     */
    REFDATA_MODE: z.enum(['recorded', 'live', 'off']).default('recorded'),
    /** Narrows the connectors' own hosts (comma-separated); empty means the connectors' list. */
    REFDATA_ALLOWED_HOSTS: z.preprocess(
      (v) => (v === '' ? undefined : v),
      z
        .string()
        .optional()
        .transform((v) =>
          v
            ? v
                .split(',')
                .map((h) => h.trim().toLowerCase())
                .filter(Boolean)
            : undefined,
        ),
    ),
    /** Where recorded responses live, when not the ones shipped with the code. */
    REFDATA_RECORDINGS_DIR: optionalString,
    /** Contact in the User-Agent of outbound requests (the National Weather Service asks for one). */
    REFDATA_CONTACT: optionalString,
    /** Free Census Data API key (a secret; ACS works without one at low volume). */
    CENSUS_API_KEY: optionalString,
  })
  .superRefine((v, ctx) => {
    // SCL-12: recorded responses are synthetic; a production tenant must never get them.
    if (v.DATA_CLASSIFICATION_MODE === 'production' && v.REFDATA_MODE === 'recorded')
      ctx.addIssue({
        code: 'custom',
        path: ['REFDATA_MODE'],
        message: 'recorded reference data is synthetic; use live or off in production (SCL-12)',
      });
  });

/**
 * SCL-12: the enclave may hold real criminal-justice data only once it runs in
 * an authorized government environment and has passed the state CJIS audit.
 * In production mode both facts must be declared by the deployment.
 */
function requireAuthorizedEnvironment(
  v: {
    DATA_CLASSIFICATION_MODE: 'synthetic' | 'production';
    CJIS_AUTHORIZED_ENVIRONMENT?: string | undefined;
    CJIS_STATE_AUDIT_PASSED_ON?: string | undefined;
  },
  ctx: z.RefinementCtx,
): void {
  if (v.DATA_CLASSIFICATION_MODE !== 'production') return;
  if (!v.CJIS_AUTHORIZED_ENVIRONMENT)
    ctx.addIssue({
      code: 'custom',
      path: ['CJIS_AUTHORIZED_ENVIRONMENT'],
      message: 'production mode needs the authorized environment declared (SCL-12)',
    });
  if (!v.CJIS_STATE_AUDIT_PASSED_ON)
    ctx.addIssue({
      code: 'custom',
      path: ['CJIS_STATE_AUDIT_PASSED_ON'],
      message: 'production mode needs the state CJIS audit date (SCL-12)',
    });
}

const cjisCommon = baseSchema.extend({
  /** The enclave's own database (never the platform's). */
  CJIS_DATABASE_URL: url,
  CJIS_OPENBAO_ADDR: url,
  CJIS_OPENBAO_TOKEN_FILE: z.string().min(1).default('/bao-init/app-token'),
  /** The enclave's own Keycloak as the enclave reaches it, e.g. http://cjis-idp:8080/auth */
  CJIS_IDP_INTERNAL_BASE: url,
  /** As browsers see it; token issuers start with this, e.g. https://localhost:8443/auth */
  CJIS_IDP_PUBLIC_BASE: url,
  CJIS_IDP_REALM: z.string().min(1).default('cjis'),
  /** Tokens must name this audience (ADR-0036). */
  CJIS_API_AUDIENCE: z.string().min(1).default('cjis-api'),
  /**
   * Authentication methods (`amr`) that count as the second factor (SEC-12,
   * SEC-07). Production: the passkey only. A development stack adds `otp` for
   * its test client's direct grant.
   */
  CJIS_SECOND_FACTORS: z
    .string()
    .default('hwk')
    .transform((v) =>
      v
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  CJIS_AUTHORIZED_ENVIRONMENT: optionalString,
  /** ISO date the state CJIS audit was passed (SCL-12). */
  CJIS_STATE_AUDIT_PASSED_ON: optionalString,
  /** System use notification shown before sign-in (AC-8); a default text applies when absent. */
  CJIS_SYSTEM_USE_NOTICE: optionalString,
});

/** CJIS enclave API (SEC-12): its own database, keys and identity, nothing shared. */
export const cjisSchema = cjisCommon.superRefine(requireAuthorizedEnvironment);

/** The enclave worker: system jobs as `cjis_job`, and the identity provider's admin client. */
export const cjisWorkerSchema = cjisCommon
  .extend({
    CJIS_IDP_ADMIN_CLIENT_SECRET: z.string().min(16),
  })
  .superRefine(requireAuthorizedEnvironment);

/** The one-shot provisioning of the enclave realm (and the exercise agency on synthetic stacks). */
export const cjisProvisionSchema = baseSchema
  .extend({
    CJIS_DATABASE_URL: url,
    CJIS_OPENBAO_ADDR: url,
    CJIS_OPENBAO_TOKEN_FILE: z.string().min(1).default('/bao-init/app-token'),
    CJIS_IDP_INTERNAL_BASE: url,
    CJIS_IDP_REALM: z.string().min(1).default('cjis'),
    CJIS_KC_ADMIN_USER: z.string().min(1),
    CJIS_KC_ADMIN_PASSWORD: z.string().min(8),
    CJIS_IDP_ADMIN_CLIENT_SECRET: z.string().min(16),
    /** Where browsers reach the enclave gateway, e.g. https://localhost:8443 */
    CJIS_PUBLIC_URL: url,
    /** Synthetic stacks only: the exercise agency, its accounts and a test client. */
    CJIS_DEV_ACCOUNTS: z
      .enum(['true', 'false'])
      .default('false')
      .transform((v) => v === 'true'),
    CJIS_AUTHORIZED_ENVIRONMENT: optionalString,
    CJIS_STATE_AUDIT_PASSED_ON: optionalString,
  })
  .superRefine(requireAuthorizedEnvironment);

export type BaseConfig = z.infer<typeof baseSchema>;
export type PlatformConfig = z.infer<typeof platformSchema>;
export type WorkerConfig = z.infer<typeof workerSchema>;
export type CjisConfig = z.infer<typeof cjisSchema>;
export type CjisWorkerConfig = z.infer<typeof cjisWorkerSchema>;
export type CjisProvisionConfig = z.infer<typeof cjisProvisionSchema>;

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

/** The AI settings as the provider factory reads them (ADR-0043); the key stays out of logs. */
export function aiEnv(c: z.infer<typeof platformSchema>): Record<string, string | undefined> {
  return {
    OPENAI_API_KEY: c.OPENAI_API_KEY,
    OPENAI_BASE_URL: c.OPENAI_BASE_URL,
    OPENAI_ORGANIZATION: c.OPENAI_ORGANIZATION,
    AI_MODEL_TEXT: c.AI_MODEL_TEXT,
    AI_MODEL_VISION: c.AI_MODEL_VISION,
    AI_MODEL_CLASSIFIER: c.AI_MODEL_CLASSIFIER,
    AI_MODEL_TRANSCRIPTION: c.AI_MODEL_TRANSCRIPTION,
    AI_MODEL_SPEECH: c.AI_MODEL_SPEECH,
    AI_TIMEOUT_MS: String(c.AI_TIMEOUT_MS),
  };
}
