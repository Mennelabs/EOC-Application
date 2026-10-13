/**
 * The photo queue (FLD-07, FLD-12, FLD-13, FLD-14, PHO-06, SCL-06): photos
 * taken first wait on the phone until the record they are tagged with is
 * received, then go up with the record's server id; a lost connection keeps
 * everything; a resend reuses the same ticket; the bytes leave the phone once
 * the server holds them; a refused record leaves the photo for the person.
 */
import { describe, expect, it } from 'vitest';
import { Outbox } from '../src/outbox.ts';
import {
  PHOTOS,
  PhotoQueue,
  recordTypeForCommand,
  type PhotoApi,
  type PhotoDoc,
} from '../src/photos.ts';
import { MemoryStore } from '../src/storage.ts';

class Offline extends Error {}

class FakePhotos implements PhotoApi {
  tickets = new Map<string, string>();
  uploaded = new Map<string, number>();
  completed: { photoId: string; recordType?: string; recordId?: string }[] = [];
  offline = false;
  loseNextUpload = false;
  async ticket(input: Parameters<PhotoApi['ticket']>[0]) {
    if (this.offline) throw new Offline();
    const id = this.tickets.get(input.clientUuid) ?? `p-${this.tickets.size + 1}`;
    this.tickets.set(input.clientUuid, id);
    return { photoId: id, status: 'uploading' };
  }
  async upload(photoId: string, _ct: string, data: Uint8Array) {
    if (this.offline) throw new Offline();
    if (this.loseNextUpload) {
      this.loseNextUpload = false;
      return;
    }
    this.uploaded.set(photoId, data.length);
  }
  async complete(photoId: string, link?: { recordType: string; recordId: string }) {
    if (this.offline) throw new Offline();
    if (!this.uploaded.has(photoId))
      throw Object.assign(new Error('incomplete'), { status: 409, code: 'upload_incomplete' });
    this.completed.push({ photoId, ...(link ?? {}) });
    return { status: 'uploaded' };
  }
}

function setup() {
  const store = new MemoryStore();
  const outbox = new Outbox(store);
  const queue = new PhotoQueue(store, outbox, { isOffline: (e) => e instanceof Offline });
  return { store, outbox, queue, api: new FakePhotos() };
}

const jpeg = btoa('fake-jpeg-bytes');

describe('photo queue', () => {
  it('waits for the tagged record, then uploads with its server id and drops the bytes', async () => {
    const { store, outbox, queue, api } = setup();
    const photo = await queue.add({ contentType: 'image/jpeg', data: jpeg, bytes: 15 });
    // Photo first: nothing goes up until it is tagged.
    expect(await queue.runOnce(api)).toMatchObject({ sent: 0, waiting: 1 });
    expect((await queue.untagged()).map((p) => p.id)).toEqual([photo.id]);
    const cmd = await outbox.enqueue({ kind: 'assessment.record', body: { degree: 'major' } });
    await queue.tag([photo.id], cmd.id);
    expect(await queue.untagged()).toEqual([]);
    // The record has not reached the server yet.
    expect(await queue.runOnce(api)).toMatchObject({ sent: 0, waiting: 1 });
    expect(api.tickets.size).toBe(0);
    await outbox.markResult({
      id: cmd.id,
      result: 'applied',
      status: 201,
      record: { type: 'assessment', id: '11111111-1111-4111-8111-111111111111', version: 1 },
    });
    expect(await queue.runOnce(api)).toMatchObject({ sent: 1, waiting: 0 });
    expect(api.completed).toEqual([
      {
        photoId: 'p-1',
        recordType: 'field_assessment',
        recordId: '11111111-1111-4111-8111-111111111111',
      },
    ]);
    const after = await store.get<PhotoDoc>(PHOTOS, photo.id);
    expect(after).toMatchObject({ stage: 'received', data: '' });
    // A second run sends nothing again.
    expect(await queue.runOnce(api)).toMatchObject({ sent: 0 });
  });

  it('keeps everything through a lost connection and reuses the ticket', async () => {
    const { outbox, queue, api } = setup();
    const cmd = await outbox.enqueue({ kind: 'need.done', targetId: 'n-1', body: { note: 'x' } });
    await outbox.markResult({ id: cmd.id, result: 'applied', status: 200, record: null });
    const p = await queue.add({
      contentType: 'image/jpeg',
      data: jpeg,
      bytes: 15,
      commandId: cmd.id,
    });
    api.loseNextUpload = true;
    // The bytes never arrived: completion says so and the photo goes back to "send the bytes".
    expect(await queue.runOnce(api)).toMatchObject({ sent: 0, waiting: 1 });
    api.offline = true;
    expect(await queue.runOnce(api)).toMatchObject({ sent: 0, offline: true });
    api.offline = false;
    expect(await queue.runOnce(api)).toMatchObject({ sent: 1 });
    expect(api.tickets.size).toBe(1);
    expect(api.completed[0]).toMatchObject({ recordType: 'need', recordId: 'n-1' });
    expect(await queue.remove(p.id)).toBe(false);
  });

  it('leaves the photo for the person when its record is refused', async () => {
    const { outbox, queue, api } = setup();
    const cmd = await outbox.enqueue({ kind: 'hazard.report', body: {} });
    const p = await queue.add({
      contentType: 'image/jpeg',
      data: jpeg,
      bytes: 15,
      commandId: cmd.id,
    });
    await outbox.markResult({
      id: cmd.id,
      result: 'rejected',
      status: 400,
      record: null,
      error: { code: 'validation_failed', message: 'no' },
    });
    expect(await queue.runOnce(api)).toMatchObject({ sent: 0, failed: 1 });
    expect(api.tickets.size).toBe(0);
    expect((await queue.all())[0]).toMatchObject({ stage: 'failed', data: jpeg });
    expect(await queue.remove(p.id)).toBe(true);
    expect(await queue.all()).toEqual([]);
  });

  it('names the record a command saves, including frontline role records (record.<kind>)', () => {
    expect(recordTypeForCommand('assessment.record')).toBe('field_assessment');
    expect(recordTypeForCommand('record.pet_intake')).toBe('pet_intake');
    expect(recordTypeForCommand('record.search_mark')).toBe('search_mark');
    // Records that never carry photos (children's records, health notes) name nothing (FR-26).
    expect(recordTypeForCommand('record.child_check_in')).toBeNull();
    expect(recordTypeForCommand('record.health_note')).toBeNull();
  });
});
