/**
 * API client. Adds the bearer token, an Idempotency-Key on creates
 * (BRD:FR-00.06), If-Match on versioned changes (BRD:FR-00.05) and, when the
 * server answers 428, asks the person to confirm and give a reason, then
 * retries with X-Confirm / X-Reason (RULE-14). Errors surface as ApiFailure
 * with the server's envelope (BRD:FR-00.07).
 */
import { accessToken } from '../auth/oidc.ts';

export interface Envelope {
  code: string;
  message: string;
  fields: { name: string; message: string }[];
  retryable: boolean;
  details?: unknown;
  requestId?: string;
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

/** Set by the app shell: shows the confirmation dialog and resolves with the answer. */
let confirmHandler: (
  action: string,
  description: string,
  draft?: string,
) => Promise<Confirmation> = async () => ({
  confirmed: false,
  reason: '',
});

export function setConfirmHandler(fn: typeof confirmHandler): void {
  confirmHandler = fn;
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  body?: unknown;
  version?: number;
  idempotent?: boolean;
  confirmation?: Confirmation;
}

export async function api<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const token = await accessToken();
  if (!token)
    throw new ApiFailure(401, {
      code: 'signed_out',
      message: 'Your session ended. Sign in again.',
      fields: [],
      retryable: false,
    });
  const headers: Record<string, string> = { authorization: `Bearer ${token}` };
  const method = options.method ?? (options.body !== undefined ? 'POST' : 'GET');
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  if (options.version !== undefined) headers['if-match'] = `"${options.version}"`;
  if (options.idempotent ?? method === 'POST') headers['idempotency-key'] = crypto.randomUUID();
  if (options.confirmation?.confirmed) {
    headers['x-confirm'] = 'true';
    headers['x-reason'] = options.confirmation.reason;
  }
  const res = await fetch(`/api/v1${path}`, {
    method,
    headers,
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
  });
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  const json = text ? (JSON.parse(text) as unknown) : null;
  if (res.ok) return json as T;
  const envelope = json as Envelope;
  if (res.status === 428 && !options.confirmation) {
    const details = (envelope.details ?? {}) as { action?: string };
    // A reason already written on the form seeds the dialog; the person still confirms it.
    const body = options.body as { reason?: unknown } | undefined;
    const draft = typeof body?.reason === 'string' ? body.reason : undefined;
    const confirmation = await confirmHandler(details.action ?? '', envelope.message, draft);
    if (!confirmation.confirmed)
      throw new ApiFailure(428, { ...envelope, code: 'cancelled', message: 'Cancelled.' });
    // Same Idempotency-Key semantics: the retried request is the same intent.
    return api<T>(path, { ...options, confirmation });
  }
  throw new ApiFailure(res.status, envelope);
}

export const describeFailure = (err: unknown): string => {
  if (err instanceof ApiFailure) {
    const fields = err.envelope.fields?.map((f) => `${f.name}: ${f.message}`).join('; ');
    return fields ? `${err.envelope.message} ${fields}` : err.envelope.message;
  }
  return err instanceof Error ? err.message : 'Something went wrong.';
};

/**
 * Downloads a file the API produces (NED-07 CSV export): same bearer token, the
 * same confirmation on 428, then a browser download of the response body.
 */
export async function download(
  path: string,
  filename: string,
  confirmation?: Confirmation,
): Promise<void> {
  const token = await accessToken();
  if (!token)
    throw new ApiFailure(401, {
      code: 'signed_out',
      message: 'Your session ended. Sign in again.',
      fields: [],
      retryable: false,
    });
  const headers: Record<string, string> = { authorization: `Bearer ${token}` };
  if (confirmation?.confirmed) {
    headers['x-confirm'] = 'true';
    headers['x-reason'] = confirmation.reason;
  }
  const res = await fetch(`/api/v1${path}`, { headers });
  if (res.status === 428 && !confirmation) {
    const envelope = (await res.json()) as Envelope;
    const details = (envelope.details ?? {}) as { action?: string };
    const answer = await confirmHandler(details.action ?? '', envelope.message);
    if (!answer.confirmed)
      throw new ApiFailure(428, { ...envelope, code: 'cancelled', message: 'Cancelled.' });
    return download(path, filename, answer);
  }
  if (!res.ok) throw new ApiFailure(res.status, (await res.json()) as Envelope);
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/**
 * Sends a file's bytes as the request body (reference imports, ADR-0041):
 * the same bearer token and error envelope as `api`, a PUT with the file's
 * own content type.
 */
/** A file the API produces, for the page to play or show (PUB-14 audio). */
export async function fetchBlob(path: string): Promise<Blob> {
  const token = await accessToken();
  if (!token)
    throw new ApiFailure(401, {
      code: 'signed_out',
      message: 'Your session ended. Sign in again.',
      fields: [],
      retryable: false,
    });
  const res = await fetch(`/api/v1${path}`, { headers: { authorization: `Bearer ${token}` } });
  if (!res.ok) throw new ApiFailure(res.status, (await res.json()) as Envelope);
  return res.blob();
}

export async function upload<T>(
  path: string,
  file: Blob,
  contentType: string,
  options: { version?: number } = {},
): Promise<T> {
  const token = await accessToken();
  if (!token)
    throw new ApiFailure(401, {
      code: 'signed_out',
      message: 'Your session ended. Sign in again.',
      fields: [],
      retryable: false,
    });
  const res = await fetch(`/api/v1${path}`, {
    method: 'PUT',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': contentType,
      ...(options.version !== undefined ? { 'if-match': `"${options.version}"` } : {}),
    },
    body: file,
  });
  const text = await res.text();
  const json = text ? (JSON.parse(text) as unknown) : null;
  if (res.ok) return json as T;
  throw new ApiFailure(res.status, json as Envelope);
}
