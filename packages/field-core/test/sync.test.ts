/**
 * The outbox and the sync loop (FLD-13, FLD-14, FLD-02, NFR-07, NFR-08,
 * AC-00B, AC-00C, SCL-06): a command is saved on the phone first and keeps
 * its id through a lost connection, so the server sees it once; results
 * mark local records received; a conflict on an untouched field rebases,
 * one on the same field waits for a person; append-only facts never
 * conflict; a pull refreshes only newer records; personal details are
 * cleared after sync and at check-out; a wipe clears everything.
 */
import { describe, expect, it } from 'vitest';
import { reconcile } from '../src/conflicts.ts';
import { Outbox } from '../src/outbox.ts';
import { purgePersonalData } from '../src/purge.ts';
import { MemoryStore } from '../src/storage.ts';
import { SyncLoop, type ChangeWire, type CommandResultWire, type FieldApi } from '../src/sync.ts';

/** A server double that behaves like services/api routes/field-sync.ts: applied once per id, duplicate after. */
class FakeApi implements FieldApi {
  applied = new Map<string, CommandResultWire>();
  feed: ChangeWire[] = [];
  records = new Map<string, Record<string, unknown> & { id: string; version: number }>();
  failNextPost = false;
  failNextSync = false;
  /** SEC-13: changes at or below this were pruned; an older cursor is told to start over. */
  prunedThrough = 0;
  wipe = false;
  posts = 0;
  versions = new Map<string, number>();

  async postCommands(input: Parameters<FieldApi['postCommands']>[0]) {
    this.posts += 1;
    if (this.failNextPost) {
      this.failNextPost = false;
      throw new Error('network unreachable');
    }
    const results: CommandResultWire[] = [];
    for (const c of input.commands) {
      const seen = this.applied.get(c.id);
      if (seen) {
        results.push({ ...seen, result: 'duplicate' });
        continue;
      }
      let r: CommandResultWire;
      if (c.kind === 'mission.delete') {
        r = {
          id: c.id,
          kind: c.kind,
          result: 'rejected',
          status: 400,
          record: null,
          error: { code: 'unknown_command', message: 'no' },
        };
      } else if (c.targetId && c.version !== undefined) {
        const current = this.versions.get(c.targetId) ?? 1;
        if (c.version !== current) {
          r = {
            id: c.id,
            kind: c.kind,
            result: 'conflict',
            status: 409,
            record: { type: 'assignment', id: c.targetId, version: current },
            current: { id: c.targetId, version: current, state: 'dispatched', note: 'server note' },
          };
        } else {
          this.versions.set(c.targetId, current + 1);
          r = {
            id: c.id,
            kind: c.kind,
            result: 'applied',
            status: 200,
            record: { type: 'assignment', id: c.targetId, version: current + 1 },
          };
        }
      } else {
        r = {
          id: c.id,
          kind: c.kind,
          result: 'applied',
          status: 201,
          record: { type: c.kind.split('.')[0]!, id: c.id, version: 1 },
        };
      }
      this.applied.set(c.id, r);
      results.push(r);
    }
    return {
      results,
      device: this.wipe ? { id: 'dev', status: 'wipe_requested', wipe: true } : null,
    };
  }
  async getSync(input: { cursor: number; limit?: number }) {
    if (this.failNextSync) {
      this.failNextSync = false;
      throw new Error('timeout');
    }
    if (input.cursor < this.prunedThrough)
      throw Object.assign(new Error('cursor expired'), { status: 410, code: 'cursor_expired' });
    const changes = this.feed.filter((c) => c.seq > input.cursor).slice(0, input.limit ?? 500);
    const more = this.feed.filter((c) => c.seq > input.cursor).length > changes.length;
    return {
      cursor: changes.length ? changes[changes.length - 1]!.seq : input.cursor,
      more,
      changes,
      device: this.wipe ? { id: 'dev', status: 'wipe_requested', wipe: true } : null,
    };
  }
  fetched: string[] = [];
  async fetchRecords(items: { type: string; id: string }[]) {
    return items.map((i) => {
      this.fetched.push(`${i.type}:${i.id}`);
      return { ...i, record: this.records.get(`${i.type}:${i.id}`) ?? null };
    });
  }
}

const change = (
  seq: number,
  recordType: string,
  recordId: string,
  version: number | null,
): ChangeWire => ({
  seq,
  recordType,
  recordId,
  version,
  op: 'upsert',
  scope: { kind: 'team', id: 'team-1' },
  at: new Date().toISOString(),
});

describe('outbox (FLD-13, AC-00C)', () => {
  it('saves a command on the phone first, in order, and badges the local record by its worst command', async () => {
    const store = new MemoryStore();
    const outbox = new Outbox(store, { newId: () => 'fixed-id' });
    const a = await outbox.enqueue({
      kind: 'position.batch',
      body: { positions: [] },
      localRef: { collection: 'assessments', id: 'r1' },
    });
    expect(a.id).toBe('fixed-id');
    expect(a.status).toBe('on_this_phone');
    expect(a.seq).toBe(1);
    const b = await outbox.enqueue({
      kind: 'hazard.report',
      body: {},
      id: 'second',
      localRef: { collection: 'assessments', id: 'r1' },
    });
    expect(b.seq).toBe(2);
    expect((await outbox.pending()).map((c) => c.id)).toEqual(['fixed-id', 'second']);
    expect(await outbox.statusOf({ collection: 'assessments', id: 'r1' })).toBe('on_this_phone');
    await outbox.markResult({ id: 'fixed-id', result: 'applied', status: 201, record: null });
    expect(await outbox.statusOf({ collection: 'assessments', id: 'r1' })).toBe('on_this_phone'); // 'second' still waits
    await outbox.markResult({
      id: 'second',
      result: 'conflict',
      status: 409,
      record: null,
      current: { version: 3 },
    });
    expect(await outbox.statusOf({ collection: 'assessments', id: 'r1' })).toBe('conflict');
    expect((await outbox.pending()).length).toBe(0);
    await outbox.resolve('second');
    expect(await outbox.statusOf({ collection: 'assessments', id: 'r1' })).toBe('received');
  });
});

describe('sync loop (FLD-13, NFR-07, NFR-08, AC-00B)', () => {
  it('a lost connection keeps the commands with their ids; the next round replays them and the server applies each once', async () => {
    const store = new MemoryStore();
    const api = new FakeApi();
    const statuses: string[] = [];
    const loop = new SyncLoop(store, api, { events: { onStatus: (s) => statuses.push(s.phase) } });
    await store.put('assessments', {
      id: 'r1',
      syncState: 'on_this_phone',
      residentName: 'Pat Example',
      damage: 'minor',
    });
    await loop.outbox.enqueue({
      kind: 'hazard.report',
      body: { kind: 'debris' },
      localRef: { collection: 'assessments', id: 'r1' },
    });
    await loop.outbox.enqueue({
      kind: 'position.batch',
      body: { positions: [{ lat: 1, lon: 1 }] },
    });
    api.failNextPost = true;
    const first = await loop.runOnce();
    expect(first.ok).toBe(false);
    expect(loop.status.phase).toBe('offline');
    expect(loop.status.pending).toBe(2);
    expect(loop.nextDelayMs()).toBe(2_000);
    const stillHere = await loop.outbox.pending();
    expect(stillHere.map((c) => c.status)).toEqual(['on_this_phone', 'on_this_phone']);
    expect(stillHere[0]!.attempts).toBe(1);
    const second = await loop.runOnce();
    expect(second.ok).toBe(true);
    expect(second.sent).toBe(2);
    expect(second.applied).toBe(2);
    expect(api.applied.size).toBe(2);
    expect(loop.status).toMatchObject({ phase: 'idle', pending: 0, conflicts: 0, backoffMs: 0 });
    expect(loop.nextDelayMs()).toBe(0);
    // The local record is received and, after sync, its personal details are gone (FLD-14).
    const r1 = await store.get<{ syncState: string; residentName: unknown; damage: string }>(
      'assessments',
      'r1',
    );
    expect(r1!.syncState).toBe('received');
    expect(r1!.residentName).toBeNull();
    expect(r1!.damage).toBe('minor');
    // A third round with the same ids (say the phone had not recorded the answer) is all duplicates: nothing applied twice.
    for (const c of await loop.outbox.all())
      await store.put('outbox', { ...c, status: 'on_this_phone' });
    const third = await loop.runOnce();
    expect(third.applied).toBe(2);
    expect(api.applied.size).toBe(2);
    expect(statuses).toContain('sending');
    expect(statuses).toContain('receiving');
  });

  it('a stale command on an untouched field rebases onto the current version; the same field moved both ways waits for a person; a rejection stays visible', async () => {
    const store = new MemoryStore();
    const api = new FakeApi();
    api.versions.set('a1', 3);
    const conflicts: string[] = [];
    const loop = new SyncLoop(store, api, {
      events: { onConflict: (_c, r) => conflicts.push(r.kind) },
    });
    await store.put('assignments', {
      id: 'a1',
      version: 2,
      state: 'dispatched',
      note: 'server note',
    });
    // Built on version 2; the server is at 3 and its note is unchanged from our base → rebase.
    await loop.outbox.enqueue({
      kind: 'assignment.status',
      targetId: 'a1',
      version: 2,
      body: { to: 'en_route' },
      localRef: { collection: 'assignments', id: 'a1' },
    });
    await loop.outbox.enqueue({ kind: 'mission.delete', targetId: 'm1', body: {} });
    const round = await loop.runOnce();
    expect(round.conflicts).toBe(1);
    expect(conflicts).toEqual(['rebase']);
    const after = await loop.outbox.all();
    const rebased = after.find((c) => c.kind === 'assignment.status')!;
    expect(rebased.version).toBe(3);
    expect(rebased.status).toBe('on_this_phone');
    expect(after.find((c) => c.kind === 'mission.delete')!.status).toBe('rejected');
    expect(loop.status.conflicts).toBe(1); // the rejection
    const next = await loop.runOnce();
    expect(next.applied).toBe(1);
    expect(api.versions.get('a1')).toBe(4);
    // Same field both ways: our base says note 'server note', the server now says 'changed by dispatch', we say 'mine' → a person decides.
    await store.put('assignments', {
      id: 'a1',
      version: 4,
      state: 'en_route',
      note: 'server note',
    });
    api.applied.clear();
    api.versions.set('a1', 5);
    const fake = api.postCommands.bind(api);
    api.postCommands = async (input) => {
      const res = await fake(input);
      for (const r of res.results)
        if (r.result === 'conflict')
          r.current = { id: 'a1', version: 5, state: 'en_route', note: 'changed by dispatch' };
      return res;
    };
    await loop.outbox.enqueue({
      kind: 'assignment.status',
      targetId: 'a1',
      version: 4,
      body: { note: 'mine' },
      localRef: { collection: 'assignments', id: 'a1' },
    });
    await loop.runOnce();
    expect(conflicts.at(-1)).toBe('needs_person');
    const local = await store.get<{
      syncState: string;
      serverCurrent: { note: string };
      note: string;
    }>('assignments', 'a1');
    expect(local!.syncState).toBe('conflict');
    expect(local!.serverCurrent.note).toBe('changed by dispatch');
    expect(local!.note).toBe('server note'); // the local record is never overwritten by the server's value (FLD-13)
    expect((await loop.outbox.all()).some((c) => c.status === 'conflict')).toBe(true);
  });

  it('pulls from the cursor, refreshes only records newer than the phone has, pages, and remembers the cursor', async () => {
    const store = new MemoryStore();
    const api = new FakeApi();
    api.records.set('mission:m1', { id: 'm1', version: 2, summary: 'v2' });
    api.records.set('hazard:h1', { id: 'h1', version: 1, kind: 'debris' });
    api.records.set('mission:m2', { id: 'm2', version: 1, summary: 'new' });
    await store.put('missions', { id: 'm1', version: 2, summary: 'already v2' });
    api.feed = [
      change(1, 'mission', 'm1', 2),
      change(2, 'hazard', 'h1', 1),
      change(3, 'position', 'team-1', null),
      change(4, 'mission', 'm2', 1),
    ];
    const loop = new SyncLoop(store, api);
    const fetched = api.fetched;
    const r = await loop.runOnce();
    expect(r.ok).toBe(true);
    expect(r.received).toBe(2);
    expect(fetched.sort()).toEqual(['hazard:h1', 'mission:m2']); // m1 is already at version 2; positions are not fetched
    expect((await store.get<{ summary: string }>('missions', 'm1'))!.summary).toBe('already v2');
    expect((await store.get<{ syncState: string }>('hazards', 'h1'))!.syncState).toBe('received');
    expect(await store.getMeta('cursor')).toBe('4');
    // Nothing new: no fetches, cursor stays.
    fetched.length = 0;
    await loop.runOnce();
    expect(fetched).toEqual([]);
    expect(await store.getMeta('cursor')).toBe('4');
    // A failed pull keeps the cursor where it was.
    api.feed.push(change(5, 'mission', 'm2', 2));
    api.failNextSync = true;
    expect((await loop.runOnce()).ok).toBe(false);
    expect(await store.getMeta('cursor')).toBe('4');
  });

  it('SEC-13: a cursor below what the server keeps downloads the area again and resumes from its cursor, once a round', async () => {
    const store = new MemoryStore();
    const api = new FakeApi();
    api.records.set('mission:m9', { id: 'm9', version: 1, summary: 'after the package' });
    api.feed = [change(10, 'mission', 'm8', 1), change(12, 'mission', 'm9', 1)];
    api.prunedThrough = 10;
    let resyncs = 0;
    const loop = new SyncLoop(store, api, {
      events: {
        onResync: async () => {
          resyncs += 1;
          return 11; // the area package's cursor, taken before its snapshot
        },
      },
    });
    const r = await loop.runOnce();
    expect(r.ok).toBe(true);
    expect(resyncs).toBe(1);
    expect(api.fetched).toEqual(['mission:m9']);
    expect(await store.getMeta('cursor')).toBe('12');

    // The server pruned past the phone again while it could not download: the round fails, the
    // cursor stays, and the next round tries again.
    api.prunedThrough = 20;
    const stuck = new SyncLoop(store, api, { events: { onResync: async () => null } });
    expect((await stuck.runOnce()).ok).toBe(false);
    expect(await store.getMeta('cursor')).toBe('12');
    // Without a way to download, an expired cursor is a failed round, never an endless loop.
    expect((await new SyncLoop(store, api).runOnce()).ok).toBe(false);
  });

  it('a status or receipt change refreshes the team or message it belongs to; a record no longer visible leaves the phone (FLD-14)', async () => {
    const store = new MemoryStore();
    const api = new FakeApi();
    await store.put('assignments', { id: 'a-old', version: 1, state: 'dispatched' });
    api.records.set('team_status:s1', {
      id: 's1',
      version: 0,
      teamId: 'team-1',
      name: 'DA 2',
      status: 'on_task',
    });
    api.records.set('field_message_receipt:r1', {
      id: 'r1',
      version: 0,
      messageId: 'm-1',
      body: 'Use the west entrance.',
    });
    api.feed = [
      change(1, 'team_status', 's1', null),
      change(2, 'field_message_receipt', 'r1', null),
      change(3, 'assignment', 'a-old', 2),
    ];
    const loop = new SyncLoop(store, api);
    expect((await loop.runOnce()).ok).toBe(true);
    expect(await store.get('teams', 'team-1')).toMatchObject({
      status: 'on_task',
      syncState: 'received',
    });
    expect(await store.get('messages', 'm-1')).toMatchObject({ body: 'Use the west entrance.' });
    expect(await store.get('team_status', 's1')).toBeNull();
    // The assignment was released from this team: the server answers null and the phone drops it.
    expect(await store.get('assignments', 'a-old')).toBeNull();
  });

  it('a wipe requested for the device clears every collection and the cursor, and the loop stops (FLD-02, FLD-14)', async () => {
    const store = new MemoryStore();
    const api = new FakeApi();
    await store.setMeta('device.id', 'dev');
    await store.setMeta('cursor', '9');
    await store.put('assessments', { id: 'r1', residentName: 'Pat' });
    await store.put('missions', { id: 'm1', version: 1 });
    let wiped = false;
    const loop = new SyncLoop(store, api, { events: { onWipe: () => (wiped = true) } });
    api.wipe = true;
    const r = await loop.runOnce();
    expect(r.wiped).toBe(true);
    expect(wiped).toBe(true);
    expect(await store.list('assessments')).toEqual([]);
    expect(await store.list('missions')).toEqual([]);
    expect(await store.getMeta('cursor')).toBeNull();
    expect(await store.getMeta('device.id')).toBeNull();
    expect(loop.status.phase).toBe('wiped');
    await loop.outbox.enqueue({ kind: 'position.batch', body: {} });
    expect((await loop.runOnce()).sent).toBe(0); // nothing leaves a wiped phone
  });
});

describe('reconcile (AC-00B) and purge (FLD-14)', () => {
  it('append-only facts never conflict; an already-applied state change is done; disjoint fields rebase; the same field needs a person', () => {
    expect(
      reconcile({ kind: 'position.batch', base: null, current: { version: 9 }, mine: {} }).kind,
    ).toBe('append_only');
    expect(
      reconcile({
        kind: 'assignment.status',
        base: { state: 'dispatched' },
        current: { version: 5, state: 'en_route' },
        mine: { to: 'en_route' },
        appliedCheck: (c) => c['state'] === 'en_route',
      }).kind,
    ).toBe('already_done');
    const rebase = reconcile({
      kind: 'mission.update',
      base: { summary: 'a', priority: 'normal', version: 1 },
      current: { summary: 'b', priority: 'normal', version: 2 },
      mine: { priority: 'high' },
    });
    expect(rebase).toEqual({ kind: 'rebase', version: 2, body: { priority: 'high' } });
    const person = reconcile({
      kind: 'mission.update',
      base: { summary: 'a', version: 1 },
      current: { summary: 'b', version: 2 },
      mine: { summary: 'c' },
    });
    expect(person.kind).toBe('needs_person');
    if (person.kind === 'needs_person')
      expect(person.fields).toEqual([{ name: 'summary', mine: 'c', theirs: 'b', base: 'a' }]);
    // Both sides made the same change: no dispute.
    expect(
      reconcile({
        kind: 'mission.update',
        base: { summary: 'a', version: 1 },
        current: { summary: 'c', version: 2 },
        mine: { summary: 'c' },
      }).kind,
    ).toBe('rebase');
  });

  it('after sync clears personal fields of received records only; check-out clears them all and the drafts; operational fields stay', async () => {
    const store = new MemoryStore();
    await store.put('assessments', {
      id: 'sent',
      syncState: 'received',
      residentName: 'Pat',
      residentPhone: '+1314',
      damage: 'major',
      parcelId: 'P1',
    });
    await store.put('assessments', {
      id: 'local',
      syncState: 'on_this_phone',
      residentName: 'Sam',
      damage: 'minor',
    });
    await store.put('intake_drafts', { id: 'd1', answers: { q1: 'x' } });
    await store.put('outbox', { id: 'c1', status: 'received', body: { residentName: 'Pat' } });
    await store.put('outbox', { id: 'c2', status: 'on_this_phone', body: {} });
    const a = await purgePersonalData(store, 'after_sync');
    expect(a.recordsPurged).toBe(1);
    const sent = await store.get<Record<string, unknown>>('assessments', 'sent');
    expect(sent).toMatchObject({
      residentName: null,
      residentPhone: null,
      damage: 'major',
      parcelId: 'P1',
      personalCleared: true,
    });
    expect(
      (await store.get<Record<string, unknown>>('assessments', 'local'))!['residentName'],
    ).toBe('Sam');
    const out = await purgePersonalData(store, 'check_out');
    expect(out.recordsPurged).toBe(2); // the unsent assessment and the draft
    expect(
      (await store.get<Record<string, unknown>>('assessments', 'local'))!['residentName'],
    ).toBeNull();
    expect(await store.list('intake_drafts')).toEqual([]);
    expect((await store.list('outbox')).map((c) => c.id)).toEqual(['c2']); // unsent commands are kept
  });
});
