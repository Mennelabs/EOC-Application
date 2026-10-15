/**
 * Public intake API client (no account): same origin, JSON, the execution id
 * as the Idempotency-Key on submissions (AC-11B), honest errors with the
 * server's envelope (BRD:FR-00.07). Every call can fail offline; callers
 * decide what to keep on the device (SCL-06, ACC-39).
 */
import type { AnswerValue, QuestionGraph } from '@cg/intake';

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

export class Offline extends Error {
  constructor() {
    super('offline');
  }
}

async function call<T>(
  path: string,
  init: { method?: string; body?: unknown; headers?: Record<string, string> } = {},
): Promise<T> {
  const headers: Record<string, string> = { ...(init.headers ?? {}) };
  if (init.body !== undefined) headers['content-type'] = 'application/json';
  let res: Response;
  try {
    res = await fetch(`/api/public${path}`, {
      method: init.method ?? (init.body !== undefined ? 'POST' : 'GET'),
      headers,
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    });
  } catch {
    throw new Offline();
  }
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  const json = text ? (JSON.parse(text) as unknown) : null;
  if (res.ok) return json as T;
  const env = (json ?? {}) as Partial<Envelope>;
  throw new ApiFailure(res.status, {
    code: env.code ?? 'error',
    message: env.message ?? 'Something went wrong.',
    fields: env.fields ?? [],
    retryable: env.retryable ?? res.status >= 500,
    details: env.details,
  });
}

export interface IntakeInfo {
  tenant: { slug: string; name: string; branding: Record<string, unknown> };
  event: {
    id: string;
    name: string;
    hazardType: string;
    hazards: string[];
    keywords: string[];
  };
  languages: string[];
  helpPhone: string | null;
  sms: { termsUrl: string | null; privacyUrl: string | null };
  graph: QuestionGraph & { emergencyInstructions?: Record<string, string> };
  uploads: { enabled: boolean; maxBytes?: number };
}

export const getIntake = (tenant: string, event: string, lang: string) =>
  call<IntakeInfo>(`/intake/${tenant}/${event}?lang=${encodeURIComponent(lang)}`);

export interface SubmissionBody {
  executionId: string;
  channel: 'web' | 'assisted';
  language: string;
  graphKey: string;
  graphVersion: number;
  relationship: 'own_home' | 'helper' | 'witness' | 'organization';
  answers: Record<string, AnswerValue>;
  ownWords?: string;
  needs: string[];
  consent: Record<string, boolean>;
  photoIds: string[];
  afterSubmission: Record<string, AnswerValue>;
  smsOptIn: boolean;
  aiAssisted: boolean;
  extractionId?: string;
  assisted?: { consentRecorded: boolean };
}

export interface SubmissionReceipt {
  referenceCode: string;
  status: 'received';
  verificationSuggested: boolean;
}

export const submit = (tenant: string, event: string, body: SubmissionBody) =>
  call<SubmissionReceipt>(`/intake/${tenant}/${event}/submissions`, {
    body,
    headers: { 'idempotency-key': body.executionId },
  });

export const textCode = (tenant: string, executionId: string, phone: string, language: string) =>
  call<{ status: string }>(`/intake/${tenant}/submissions/${executionId}/text-code`, {
    body: { phone, language },
  });

export const sendAfter = (
  tenant: string,
  executionId: string,
  body: { graphKey: string; graphVersion: number; answers: Record<string, AnswerValue> },
) => call<{ status: string }>(`/intake/${tenant}/submissions/${executionId}/after`, { body });

export interface ExtractionCandidate {
  questionId: string;
  value: AnswerValue;
  confidence: number;
  evidence: string;
}

export interface ExtractionResult {
  extractionId: string;
  candidates: ExtractionCandidate[];
  language: string | null;
  injectionSuspected: boolean;
  notice: string;
}

export const extract = (
  tenant: string,
  body: {
    executionId: string;
    text: string;
    language?: string;
    graphKey: string;
    graphVersion: number;
  },
) => call<ExtractionResult>(`/intake/${tenant}/extract`, { body });

export const saveDraft = (tenant: string, executionId: string, payload: unknown) =>
  call<{ resumeCode: string; expiresAt: string }>(`/intake/${tenant}/drafts`, {
    body: { executionId, payload },
  });

export const loadDraft = (tenant: string, code: string) =>
  call<{ executionId: string; payload: unknown; expiresAt: string }>(
    `/intake/${tenant}/drafts/${encodeURIComponent(code)}`,
  );

export interface UploadTicket {
  photoId: string;
  method: 'PUT';
  uploadUrl: string;
  headers: Record<string, string>;
  expiresAt: string;
}

export const requestUpload = (
  tenant: string,
  body: {
    executionId: string;
    shot: string;
    contentType: string;
    bytes: number;
    takenAt?: string;
    location?: { lat: number; lon: number };
  },
) => call<UploadTicket>(`/intake/${tenant}/photos`, { body });

export async function putObject(ticket: UploadTicket, blob: Blob): Promise<void> {
  let res: Response;
  try {
    res = await fetch(ticket.uploadUrl, { method: 'PUT', headers: ticket.headers, body: blob });
  } catch {
    throw new Offline();
  }
  if (!res.ok)
    throw new ApiFailure(res.status, {
      code: 'upload_failed',
      message: 'The photo did not upload.',
      fields: [],
      retryable: true,
    });
}

/**
 * The same bytes through the gateway when the objects host cannot be reached from this
 * browser (its name, its certificate or a strict network); the API stores them under the
 * ticket's key (SCL-04 fallback, SCL-06).
 */
export async function putObjectViaApi(
  tenant: string,
  photoId: string,
  executionId: string,
  blob: Blob,
  contentType: string,
): Promise<void> {
  let res: Response;
  try {
    res = await fetch(
      `/api/public/intake/${tenant}/photos/${photoId}/content?executionId=${encodeURIComponent(executionId)}`,
      { method: 'PUT', headers: { 'content-type': contentType }, body: blob },
    );
  } catch {
    throw new Offline();
  }
  if (!res.ok)
    throw new ApiFailure(res.status, {
      code: 'upload_failed',
      message: 'The photo did not upload.',
      fields: [],
      retryable: res.status >= 500,
    });
}

export const completeUpload = (tenant: string, photoId: string, executionId: string) =>
  call<{ photoId: string; status: string }>(`/intake/${tenant}/photos/${photoId}/complete`, {
    body: { executionId },
  });

export const lookupStart = (tenant: string, referenceCode: string, contact: string) =>
  call<{ status: string; message: string }>(`/intake/${tenant}/lookup/start`, {
    body: { referenceCode, contact },
  });

export const lookupVerify = (tenant: string, referenceCode: string, code: string) =>
  call<{ token: string; expiresAt: string }>(`/intake/${tenant}/lookup/verify`, {
    body: { referenceCode, code },
  });

export interface MyReport {
  referenceCode: string;
  submittedAt: string;
  status: string;
  verification: string;
  withdrawnAt: string | null;
  version: number;
  needs: { id: string; category: string; status: string }[];
  consent: Record<string, boolean>;
  openQuestions: { id: string; questions: unknown; message: string | null; askedAt: string }[];
}

const resident = (token: string) => ({ 'x-resident-token': token });

export const myReport = (tenant: string, token: string) =>
  call<MyReport>(`/intake/${tenant}/me`, { headers: resident(token) });

export const setConsent = (tenant: string, token: string, orgType: string, granted: boolean) =>
  call<{ orgType: string; granted: boolean }>(`/intake/${tenant}/me/consent`, {
    method: 'PATCH',
    body: { orgType, granted },
    headers: resident(token),
  });

export const correct = (
  tenant: string,
  token: string,
  body: {
    answers: Record<string, AnswerValue>;
    ownWords?: string;
    message?: string;
    correctionRequestId?: string;
  },
) =>
  call<{ status: string; version: number }>(`/intake/${tenant}/me/corrections`, {
    body,
    headers: resident(token),
  });

/** FL:FR-32: the resident's own copy as a PDF, saved through a short-lived link. */
export async function downloadMyCopy(tenant: string, token: string, lang: string): Promise<void> {
  let res: Response;
  try {
    res = await fetch(
      `/api/public/intake/${tenant}/me/export.pdf?lang=${encodeURIComponent(lang)}`,
      {
        headers: resident(token),
      },
    );
  } catch {
    throw new Offline();
  }
  if (!res.ok)
    throw new ApiFailure(res.status, {
      code: 'error',
      message: 'Something went wrong.',
      fields: [],
      retryable: res.status >= 500,
      details: undefined,
    });
  const blob = await res.blob();
  const name =
    /filename="([^"]+)"/.exec(res.headers.get('content-disposition') ?? '')?.[1] ??
    'damage-report.pdf';
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export const withdraw = (tenant: string, token: string, reason?: string) =>
  call<{ status: string }>(`/intake/${tenant}/me/withdraw`, {
    body: reason ? { reason } : {},
    headers: resident(token),
  });
