/**
 * The field app's API client (layer-4 plan §3): the routes in
 * services/api/src/routes/field-sync.ts for sync, commands, records and the
 * area package, plus check-in and device registration. It implements
 * field-core's FieldApi, so the sync loop never knows about HTTP. Every call
 * carries the access token; a failure to reach the server is thrown as
 * `offline` so the caller keeps the work on the phone (SCL-06).
 */
import type { FieldApi, PhotoApi, PhotoRecordType } from '@cg/field-core';
import { accessToken } from './auth';

export class OfflineError extends Error {
  constructor() {
    super('offline');
  }
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly body: unknown;
  constructor(status: number, code: string, message: string, body: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    this.body = body;
  }
}

export interface Me {
  accountId: string;
  tenantId: string;
  roles: { key: string; templateKey: string | null }[];
  actions: string[];
  ownRecordsOnly: string[];
}

export interface CheckIn {
  id: string;
  eventId: string;
  teamId: string | null;
  startedAt: string;
  endedAt: string | null;
  locationSharing: boolean;
  credentials: { kind: string }[];
}

export interface AreaPackage {
  asOf: string;
  cursor: number;
  eventId: string | null;
  me: { personnelId: string; name: string; teamIds: string[] };
  areaKeys: string[];
  assignments: {
    id: string;
    version: number;
    state: string;
    teamId: string | null;
    personnelId: string | null;
    mission: {
      id: string;
      version: number;
      reference: string;
      kind: string;
      state: string;
      priority: string;
      urgency: string;
      summary: string | null;
      conditions: string | null;
      location: {
        line1: string | null;
        city: string | null;
        landmark: string | null;
        usng: string | null;
        position: { lat: number; lon: number } | null;
      } | null;
    };
  }[];
  parcels: {
    id: string;
    parcelId: string;
    line1: string | null;
    city: string | null;
    postal: string | null;
    structure: string;
    unitCount: number | null;
    areaKey: string | null;
    centroid: { lat: number; lon: number } | null;
  }[];
  hazards: {
    id: string;
    version: number;
    kind: string;
    state: string;
    severity: string;
    summary: string | null;
    position: { lat: number; lon: number } | null;
    radiusM: number | null;
    unverified: boolean;
  }[];
  sites: { id: string; name: string; kind: string; status: string }[];
  jobAids: { id: string; key: string; title: string; bodyHtml: string; lang: string }[];
  /** FLD-13: the offline map package of each area, with what the phone checks it against. */
  maps: {
    areaKey: string;
    available: boolean;
    url: string | null;
    bytes: number | null;
    sha256: string | null;
    version: number | null;
    bounds: [number, number, number, number] | null;
  }[];
  /** County choices the screens follow (DCL:DEC-17: ask tribal ownership). */
  options: AreaOptions;
}

export interface AreaOptions {
  tribalOwnership: boolean;
  /** FL-16: hours on shift after which the phone reminds the worker to rest. */
  restAfterHours: number;
}

export interface VoiceDraft {
  draftId: string;
  drafts: { field: 'structure' | 'water_inside' | 'seen'; value: string; evidence: string }[];
  injectionSuspected: boolean;
  provider: { provider: string; model: string };
  notice: string;
}

export class Api implements FieldApi, PhotoApi {
  private readonly base: string;
  constructor(base: string) {
    this.base = base;
  }

  async call<T>(
    method: string,
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ): Promise<T> {
    const token = await accessToken();
    if (!token) throw new ApiError(401, 'signed_out', 'Signed out', null);
    let res: Response;
    try {
      res = await fetch(`${this.base}/api/v1${path}`, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
          ...headers,
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
    } catch {
      throw new OfflineError();
    }
    const text = await res.text();
    const json = text ? (JSON.parse(text) as unknown) : null;
    if (!res.ok) {
      const e = (json ?? {}) as { code?: string; message?: string };
      throw new ApiError(res.status, e.code ?? 'error', e.message ?? res.statusText, json);
    }
    return json as T;
  }

  /** Raw bytes (a photo) with their own content type. */
  async put(path: string, contentType: string, data: Uint8Array): Promise<void> {
    const token = await accessToken();
    if (!token) throw new ApiError(401, 'signed_out', 'Signed out', null);
    let res: Response;
    try {
      res = await fetch(`${this.base}/api/v1${path}`, {
        method: 'PUT',
        headers: { authorization: `Bearer ${token}`, 'content-type': contentType },
        body: data as unknown as BodyInit,
      });
    } catch {
      throw new OfflineError();
    }
    if (!res.ok) {
      const json = (await res.json().catch(() => ({}))) as { code?: string; message?: string };
      throw new ApiError(res.status, json.code ?? 'error', json.message ?? res.statusText, json);
    }
  }

  me(): Promise<Me> {
    return this.call('GET', '/me');
  }

  registerDevice(input: {
    installId: string;
    platform: 'ios' | 'android' | 'web';
    managed: boolean;
    model?: string;
    appVersion?: string;
  }) {
    return this.call<{ id: string; status: string }>('POST', '/devices', input);
  }

  /** FLD-03: `qr` when the staging code was scanned, `event_code` when typed. */
  checkIn(input: {
    eventCode: string;
    deviceId?: string;
    locationSharing: boolean;
    method?: 'qr' | 'event_code';
  }) {
    return this.call<CheckIn>('POST', '/check-ins', { method: 'event_code', ...input });
  }

  async openCheckIn(): Promise<CheckIn | null> {
    const list = await this.call<CheckIn[]>('GET', '/check-ins?mine=true&limit=5');
    return list.find((c) => !c.endedAt) ?? null;
  }

  area(eventId: string | null, lang: string): Promise<AreaPackage> {
    // FLD-04: with the lots' outlines, so "Is this the property?" can show the lot.
    const q = new URLSearchParams({ lang, geometry: 'true', ...(eventId ? { eventId } : {}) });
    return this.call('GET', `/field/area?${q.toString()}`);
  }

  /** FLD-09: fields drafted from what the volunteer said; each is confirmed on the phone (INT-13). */
  voiceDraft(input: { clientUuid: string; text: string; language: string }): Promise<VoiceDraft> {
    return this.call('POST', '/field-assessments/draft', input);
  }

  // ---- PhotoApi (packages/field-core photos.ts; FLD-07)
  ticket(input: Parameters<PhotoApi['ticket']>[0]) {
    return this.call<{ photoId: string; status: string }>('POST', '/field/photos', input);
  }

  upload(photoId: string, contentType: string, data: Uint8Array) {
    return this.put(`/field/photos/${photoId}/content`, contentType, data);
  }

  complete(photoId: string, link?: { recordType: PhotoRecordType; recordId: string }) {
    return this.call<{ status: string }>('POST', `/field/photos/${photoId}/complete`, link ?? {});
  }

  // ---- FieldApi (packages/field-core)
  postCommands(input: Parameters<FieldApi['postCommands']>[0]) {
    return this.call<Awaited<ReturnType<FieldApi['postCommands']>>>(
      'POST',
      '/field/commands',
      input,
    );
  }

  getSync(input: { cursor: number; limit?: number; deviceId?: string }) {
    const q = new URLSearchParams({
      cursor: String(input.cursor),
      limit: String(input.limit ?? 500),
      ...(input.deviceId ? { deviceId: input.deviceId } : {}),
    });
    return this.call<Awaited<ReturnType<FieldApi['getSync']>>>(
      'GET',
      `/field/sync?${q.toString()}`,
    );
  }

  async fetchRecords(items: { type: string; id: string }[]) {
    const res = await this.call<{ records: Awaited<ReturnType<FieldApi['fetchRecords']>> }>(
      'POST',
      '/field/records',
      { items },
    );
    return res.records;
  }
}
