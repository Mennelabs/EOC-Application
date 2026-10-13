/**
 * The photo queue (FLD-07, FLD-11, FLD-12, FLD-13, FLD-14, PHO-06, SCL-06):
 * photo first, tag after. A photo is kept on the phone, encrypted like every
 * other record, from the moment it is taken; it is tagged with the record it
 * documents (an assessment, a hazard report, a need marked done) by naming
 * the outbox command that creates or changes that record. Once that command
 * is received, the queue asks for a ticket with the photo's own id (a resend
 * gets the same ticket), sends the bytes and completes the upload with the
 * record's server id. The bytes leave the phone as soon as the server holds
 * them (FLD-14: a photo may show a person or an address). Location and time
 * are sent beside the photo, not inside it; the server strips metadata from
 * the image itself (PHO-06). A transport failure keeps everything for the
 * next try; nothing is dropped without the person choosing to.
 */
import type { Outbox } from './outbox.ts';
import type { FieldStore, StoredDoc } from './storage.ts';

export const PHOTOS = 'photos';

export type PhotoStage = 'on_this_phone' | 'ticketed' | 'uploaded' | 'received' | 'failed';

/** The server's record types a field photo can document (services/api routes/field-sync.ts). */
export type PhotoRecordType =
  | 'field_assessment'
  | 'hazard'
  | 'mission'
  | 'need'
  | 'search_mark'
  | 'placard'
  | 'site'
  | 'pet_intake'
  | 'site_walkthrough'
  | 'debris_ticket'
  | 'inspection'
  | 'road_status'
  | 'canvass_visit';

export interface PhotoDoc extends StoredDoc {
  id: string;
  contentType: string;
  /** Base64 bytes; emptied once the server has the photo. */
  data: string;
  bytes: number;
  takenAt: string;
  position?: { lat: number; lon: number };
  /** The outbox command whose record this photo documents (tagging). */
  commandId?: string;
  link?: { recordType: PhotoRecordType; recordId: string };
  stage: PhotoStage;
  photoId?: string;
  attempts: number;
  lastError?: string;
}

export interface PhotoApi {
  ticket(input: {
    clientUuid: string;
    contentType: string;
    bytes: number;
    shot: string;
    takenAt: string;
    position?: { lat: number; lon: number };
    recordType?: PhotoRecordType;
    recordId?: string;
  }): Promise<{ photoId: string; status: string }>;
  upload(photoId: string, contentType: string, data: Uint8Array): Promise<void>;
  complete(
    photoId: string,
    link?: { recordType: PhotoRecordType; recordId: string },
  ): Promise<{ status: string }>;
}

/** The command kind's first word as the server names it → the photo record type. */
const RECORD_TYPES: Record<string, PhotoRecordType> = {
  assessment: 'field_assessment',
  hazard: 'hazard',
  need: 'need',
  site: 'site',
  mission: 'mission',
};

/** Frontline role records travel as `record.<kind>` (services/api routes/field-records.ts). */
const RECORD_KINDS: readonly PhotoRecordType[] = [
  'search_mark',
  'placard',
  'pet_intake',
  'site_walkthrough',
  'debris_ticket',
  'inspection',
  'road_status',
  'canvass_visit',
];

export function recordTypeForCommand(kind: string): PhotoRecordType | null {
  const [first, second] = kind.split('.');
  if (first === 'record') return RECORD_KINDS.find((k) => k === second) ?? null;
  return RECORD_TYPES[first ?? ''] ?? null;
}

function bytesOf(b64: string): Uint8Array {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i += 1) out[i] = s.charCodeAt(i);
  return out;
}

export interface PhotoRunResult {
  sent: number;
  /** Photos waiting for their record to be received, or not yet tagged. */
  waiting: number;
  failed: number;
  offline: boolean;
}

export class PhotoQueue {
  private readonly store: FieldStore;
  private readonly outbox: Outbox;
  private readonly isOffline: (err: unknown) => boolean;
  private readonly newId: () => string;
  private readonly now: () => Date;

  constructor(
    store: FieldStore,
    outbox: Outbox,
    opts: {
      isOffline: (err: unknown) => boolean;
      newId?: () => string;
      now?: () => Date;
    },
  ) {
    this.store = store;
    this.outbox = outbox;
    this.isOffline = opts.isOffline;
    this.newId = opts.newId ?? (() => globalThis.crypto.randomUUID());
    this.now = opts.now ?? (() => new Date());
  }

  async add(input: {
    contentType: string;
    data: string;
    bytes: number;
    position?: { lat: number; lon: number };
    commandId?: string;
  }): Promise<PhotoDoc> {
    const doc: PhotoDoc = {
      id: this.newId(),
      contentType: input.contentType,
      data: input.data,
      bytes: input.bytes,
      takenAt: this.now().toISOString(),
      ...(input.position ? { position: input.position } : {}),
      ...(input.commandId ? { commandId: input.commandId } : {}),
      stage: 'on_this_phone',
      attempts: 0,
    };
    await this.store.put(PHOTOS, doc);
    return doc;
  }

  /** Tag photos taken first with the command that saves their record. */
  async tag(ids: readonly string[], commandId: string): Promise<void> {
    for (const id of ids) {
      const p = await this.store.get<PhotoDoc>(PHOTOS, id);
      if (p && p.stage === 'on_this_phone' && !p.link)
        await this.store.put(PHOTOS, { ...p, commandId });
    }
  }

  /** The person removes a photo; only while it has not left the phone. */
  async remove(id: string): Promise<boolean> {
    const p = await this.store.get<PhotoDoc>(PHOTOS, id);
    if (!p || (p.stage !== 'on_this_phone' && p.stage !== 'failed')) return false;
    await this.store.delete(PHOTOS, id);
    return true;
  }

  async all(): Promise<PhotoDoc[]> {
    return (await this.store.list<PhotoDoc>(PHOTOS)).sort((a, b) =>
      a.takenAt.localeCompare(b.takenAt),
    );
  }

  /** Untagged photos the person took and has not yet attached to a record. */
  async untagged(): Promise<PhotoDoc[]> {
    return (await this.all()).filter((p) => !p.commandId && !p.link && p.stage === 'on_this_phone');
  }

  private async resolveLink(p: PhotoDoc): Promise<PhotoDoc['link'] | 'rejected' | null> {
    if (p.link) return p.link;
    if (!p.commandId) return null;
    const cmd = await this.outbox.get(p.commandId);
    if (!cmd) return null;
    if (cmd.status === 'rejected') return 'rejected';
    if (cmd.status !== 'received') return null;
    const type = recordTypeForCommand(cmd.kind);
    const id = cmd.record?.id ?? cmd.targetId ?? null;
    if (!type || !id) return 'rejected';
    return { recordType: type, recordId: id };
  }

  async runOnce(api: PhotoApi): Promise<PhotoRunResult> {
    const out: PhotoRunResult = { sent: 0, waiting: 0, failed: 0, offline: false };
    for (const original of await this.all()) {
      if (original.stage === 'received') continue;
      let p = original;
      const link = await this.resolveLink(p);
      if (link === 'rejected') {
        // The record was refused; the photo stays for the person to re-tag or delete.
        if (p.stage !== 'failed') {
          p = { ...p, stage: 'failed', lastError: 'record_not_saved' };
          delete p.commandId;
          await this.store.put(PHOTOS, p);
        }
        out.failed += 1;
        continue;
      }
      if (p.stage === 'failed') {
        out.failed += 1;
        continue;
      }
      if (!link) {
        out.waiting += 1;
        continue;
      }
      if (!p.link) p = { ...p, link };
      try {
        if (!p.photoId) {
          const t = await api.ticket({
            clientUuid: p.id,
            contentType: p.contentType,
            bytes: p.bytes,
            shot: 'field',
            takenAt: p.takenAt,
            ...(p.position ? { position: p.position } : {}),
            recordType: link.recordType,
            recordId: link.recordId,
          });
          p = { ...p, photoId: t.photoId, stage: 'ticketed', attempts: p.attempts + 1 };
          await this.store.put(PHOTOS, p);
        }
        if (p.stage === 'ticketed' || p.stage === 'on_this_phone') {
          await api.upload(p.photoId!, p.contentType, bytesOf(p.data));
          p = { ...p, stage: 'uploaded' };
          await this.store.put(PHOTOS, p);
        }
        await api.complete(p.photoId!, link);
        // FLD-14: the bytes leave the phone once the server holds them.
        p = { ...p, stage: 'received', data: '' };
        delete p.lastError;
        await this.store.put(PHOTOS, p);
        out.sent += 1;
      } catch (err) {
        if (this.isOffline(err)) {
          await this.store.put(PHOTOS, { ...p, lastError: 'offline' });
          out.offline = true;
          return out;
        }
        const e = err as { status?: number; code?: string; message?: string };
        if (e.code === 'upload_incomplete') {
          // The bytes did not arrive; send them again next time.
          await this.store.put(PHOTOS, { ...p, stage: 'ticketed', lastError: e.code });
          out.waiting += 1;
        } else if (e.status !== undefined && e.status >= 500) {
          await this.store.put(PHOTOS, { ...p, lastError: e.code ?? String(e.status) });
          out.waiting += 1;
        } else {
          await this.store.put(PHOTOS, {
            ...p,
            stage: 'failed',
            lastError: e.code ?? e.message ?? 'error',
          });
          out.failed += 1;
        }
      }
    }
    return out;
  }

  /** Received photos leave the list after a day; their bytes are already gone. */
  async pruneReceived(olderThanMs: number): Promise<number> {
    const cutoff = this.now().getTime() - olderThanMs;
    let n = 0;
    for (const p of await this.store.list<PhotoDoc>(PHOTOS, (x) => x.stage === 'received')) {
      if (new Date(p.takenAt).getTime() < cutoff) {
        await this.store.delete(PHOTOS, p.id);
        n += 1;
      }
    }
    return n;
  }
}
