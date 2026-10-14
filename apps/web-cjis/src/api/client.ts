/**
 * Enclave API client: bearer token, Idempotency-Key on creates (FR-00.06),
 * If-Match on versioned changes (FR-00.05); on 428 it asks the person to
 * confirm with a reason and retries (RULE-14). Errors keep the server's
 * envelope. Calls go only to this origin's /api: the enclave API.
 */
import { accessToken } from '../auth/oidc.ts';

export interface Envelope {
  code: string;
  message: string;
  fields: { name: string; message: string }[];
  retryable: boolean;
  details?: unknown;
}

export class ApiFailure extends Error {
  readonly status: number;
  readonly envelope: Envelope;
  constructor(status: number, envelope: Envelope) {
    super(envelope.message);
    this.status = status;
    this.envelope = envelope;
  }
}

export interface Confirmation {
  confirmed: boolean;
  reason: string;
}

let confirmHandler: (description: string) => Promise<Confirmation> = async () => ({
  confirmed: false,
  reason: '',
});

export function setConfirmHandler(fn: typeof confirmHandler): void {
  confirmHandler = fn;
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT';
  body?: unknown;
  version?: number;
  confirmation?: Confirmation;
}

const signedOut = () =>
  new ApiFailure(401, {
    code: 'signed_out',
    message: 'Your enclave session ended. Sign in again.',
    fields: [],
    retryable: false,
  });

async function headersFor(options: RequestOptions, method: string) {
  const token = await accessToken();
  if (!token) throw signedOut();
  const headers: Record<string, string> = { authorization: `Bearer ${token}` };
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  if (options.version !== undefined) headers['if-match'] = `"${options.version}"`;
  if (method === 'POST') headers['idempotency-key'] = crypto.randomUUID();
  if (options.confirmation?.confirmed) {
    headers['x-confirm'] = 'true';
    headers['x-reason'] = options.confirmation.reason;
  }
  return headers;
}

export async function api<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const method = options.method ?? (options.body !== undefined ? 'POST' : 'GET');
  const res = await fetch(`/api/v1${path}`, {
    method,
    headers: await headersFor(options, method),
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
  });
  const text = await res.text();
  const json = text ? (JSON.parse(text) as unknown) : null;
  if (res.ok) return json as T;
  const envelope = json as Envelope;
  if (res.status === 428 && envelope.code === 'confirmation_required' && !options.confirmation) {
    const confirmation = await confirmHandler(envelope.message);
    if (!confirmation.confirmed)
      throw new ApiFailure(428, { ...envelope, code: 'cancelled', message: 'Cancelled.' });
    return api<T>(path, { ...options, confirmation });
  }
  throw new ApiFailure(res.status, envelope);
}

/** A CSV the API produces, downloaded after the same confirmation. */
export async function download(path: string, filename: string, confirmation?: Confirmation) {
  const res = await fetch(`/api/v1${path}`, {
    headers: await headersFor({ ...(confirmation ? { confirmation } : {}) }, 'GET'),
  });
  if (res.status === 428 && !confirmation) {
    const envelope = (await res.json()) as Envelope;
    const answer = await confirmHandler(envelope.message);
    if (!answer.confirmed)
      throw new ApiFailure(428, { ...envelope, code: 'cancelled', message: 'Cancelled.' });
    return download(path, filename, answer);
  }
  if (!res.ok) throw new ApiFailure(res.status, (await res.json()) as Envelope);
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export const describeFailure = (err: unknown): string => {
  if (err instanceof ApiFailure) {
    if (err.envelope.code === 'not_cjis_qualified') {
      const missing = ((err.envelope.details as { missing?: string[] } | undefined)?.missing ?? [])
        .map(missingLabel)
        .join('; ');
      return `${err.envelope.message} Missing: ${missing}.`;
    }
    const fields = err.envelope.fields?.map((f) => `${f.name}: ${f.message}`).join('; ');
    return fields ? `${err.envelope.message} ${fields}` : err.envelope.message;
  }
  return err instanceof Error ? err.message : 'Something went wrong.';
};

export function missingLabel(m: string): string {
  return (
    (
      {
        account_not_active: 'your enclave account is not active',
        agency_not_active: 'your agency is not active',
        fingerprint_check: 'a fingerprint-based record check, adjudicated',
        security_training: 'security awareness training within the last 12 months',
        role: 'an approved role',
      } as Record<string, string>
    )[m] ?? m
  );
}
