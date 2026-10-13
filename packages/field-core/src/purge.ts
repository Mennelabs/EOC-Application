/**
 * Personal-data purge (FLD-14, SEC-13, plan §5 "Device management"):
 * resident personal details are cleared from the phone after a record is
 * received by the server and at check-out; a remote wipe clears everything
 * the app holds. Collections declare which fields are personal; the purge
 * blanks those and keeps the operational rest (parcel, damage, position) so
 * the volunteer still sees what they did without carrying who lives there.
 */
import type { FieldStore, StoredDoc } from './storage.ts';
import { OUTBOX } from './outbox.ts';

/** Collection → personal fields (dot paths one level deep are enough for the field records). */
export const PERSONAL_FIELDS: Record<string, readonly string[]> = {
  assessments: [
    'residentName',
    'residentPhone',
    'residentEmail',
    'contact',
    'occupants',
    'notesPersonal',
    'photosWithPeople',
  ],
  canvass_visits: ['residentName', 'contact', 'needsDetail', 'household'],
  intake_drafts: ['answers', 'contact', 'party'],
  quick_reports: ['reporterContact', 'personsInvolved'],
  missions: ['caller', 'people'],
  search_marks: ['occupantsDetail', 'victimsDetail'],
  shelter_stays: ['guest', 'contact', 'healthNote'],
  health_notes: ['note', 'subject'],
  child_check_ins: ['child', 'guardian', 'contact'],
};

export interface PurgeReport {
  scope: 'after_sync' | 'check_out' | 'wipe';
  recordsPurged: number;
  collectionsCleared: string[];
}

/** Marks a record as received so the purge may clear its personal fields. */
export interface SyncedDoc extends StoredDoc {
  syncState?: 'on_this_phone' | 'sending' | 'received';
  personalCleared?: boolean;
}

export async function purgePersonalData(
  store: FieldStore,
  scope: PurgeReport['scope'],
): Promise<PurgeReport> {
  if (scope === 'wipe') {
    const names = await store.collections();
    for (const c of names) await store.clear(c);
    for (const key of ['cursor', 'device.id', 'session', 'pin.salt', 'outbox.seq', 'area.cursor'])
      await store.setMeta(key, null);
    return { scope, recordsPurged: 0, collectionsCleared: names };
  }
  let purged = 0;
  for (const [collection, fields] of Object.entries(PERSONAL_FIELDS)) {
    const docs = await store.list<SyncedDoc>(collection);
    for (const doc of docs) {
      if (doc.personalCleared) continue;
      // After sync: only what the server has; at check-out: everything, sent or not (the outbox keeps the command bodies encrypted until received).
      if (scope === 'after_sync' && doc.syncState !== 'received') continue;
      const next: SyncedDoc = { ...doc, personalCleared: true };
      let touched = false;
      for (const f of fields) {
        if (next[f] !== undefined && next[f] !== null) {
          next[f] = null;
          touched = true;
        }
      }
      if (touched || scope === 'check_out') {
        await store.put(collection, next);
        purged += 1;
      }
    }
  }
  if (scope === 'check_out') {
    // Received commands carry bodies with personal details; they are no longer needed once received.
    const received = await store.list<SyncedDoc & { status?: string }>(
      OUTBOX,
      (c) => c.status === 'received',
    );
    for (const c of received) await store.delete(OUTBOX, c.id);
    for (const c of ['intake_drafts', 'photos_pending'])
      if ((await store.collections()).includes(c)) await store.clear(c);
  }
  return {
    scope,
    recordsPurged: purged,
    collectionsCleared: scope === 'check_out' ? ['intake_drafts', 'photos_pending'] : [],
  };
}
