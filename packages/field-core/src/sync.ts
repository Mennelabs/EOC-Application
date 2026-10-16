/**
 * The sync loop (FLD-13, NFR-07, NFR-08, SCL-06, FLD-02): push the outbox in
 * order as command batches, pull the change feed from the cursor, refresh
 * the records named, apply the area package, and honour a wipe. Sync runs
 * on any connection; a transport failure leaves every command on the phone
 * with its id, so the next attempt replays it and the server answers
 * duplicate for anything it already applied. Retries back off. The loop is
 * independent of the platform: the app gives it an API client and a store.
 */
import { reconcile, type Resolution } from './conflicts.ts';
import { Outbox, type OutboxCommand } from './outbox.ts';
import { purgePersonalData } from './purge.ts';
import type { FieldStore, StoredDoc } from './storage.ts';

export interface CommandResultWire {
  id: string;
  kind: string;
  result: 'applied' | 'duplicate' | 'conflict' | 'rejected';
  status: number;
  record: { type: string | null; id: string | null; version: number | null } | null;
  current?: unknown;
  error?: { code: string; message: string };
}

export interface ChangeWire {
  seq: number;
  recordType: string;
  recordId: string;
  version: number | null;
  op: 'upsert' | 'delete';
  scope: { kind: string; id: string | null };
  at: string;
}

export interface DeviceWire {
  id: string;
  status: string;
  wipe: boolean;
}

/** What the app implements over fetch (same shapes as services/api routes/field-sync.ts). */
export interface FieldApi {
  postCommands(input: {
    deviceId?: string;
    commands: {
      id: string;
      kind: string;
      targetId?: string;
      version?: number;
      body: Record<string, unknown>;
      clientAt: string;
    }[];
  }): Promise<{
    results: CommandResultWire[];
    device: DeviceWire | null;
  }>;
  getSync(input: { cursor: number; limit?: number; deviceId?: string }): Promise<{
    cursor: number;
    more: boolean;
    changes: ChangeWire[];
    device: DeviceWire | null;
  }>;
  /**
   * Refetch records through POST /field/records (one call, scoped like the
   * sync, FLD-14); `record` is null when gone or no longer visible.
   */
  fetchRecords(
    items: { type: string; id: string }[],
  ): Promise<{ type: string; id: string; record: Record<string, unknown> | null }[]>;
}

export interface SyncEvents {
  onStatus?(s: SyncStatus): void;
  onWipe?(): void;
  onConflict?(cmd: OutboxCommand, resolution: Resolution): void;
  /**
   * SEC-13: the server pruned changes this phone had not read yet ("cursor expired"). The app
   * downloads its area package again and returns the package's cursor to resume from, or null
   * when it could not.
   */
  onResync?(): Promise<number | null>;
}

/** The sync's answer when the phone's cursor is below what the server still keeps. */
export const isCursorExpired = (err: unknown): boolean => {
  const e = err as { status?: unknown; code?: unknown } | null;
  return !!e && e.status === 410 && e.code === 'cursor_expired';
};

export interface SyncStatus {
  phase: 'idle' | 'sending' | 'receiving' | 'offline' | 'wiped';
  pending: number;
  conflicts: number;
  lastSyncAt: string | null;
  lastError: string | null;
  /** Next retry delay the loop will use (ms); 0 when the last round succeeded. */
  backoffMs: number;
}

/** Feed record types to local collections. */
export const RECORD_COLLECTIONS: Record<string, string> = {
  mission: 'missions',
  assignment: 'assignments',
  team: 'teams',
  team_status: 'team_status',
  check_in: 'check_ins',
  hazard: 'hazards',
  field_message: 'messages',
  field_message_receipt: 'receipts',
  safety_alert: 'alerts',
  reminder: 'reminders',
  field_device: 'devices',
  site: 'sites',
};

/** Feed types whose change refreshes another record: the server answers with that record and its id field. */
const ALIASES: Record<string, { collection: string; idField: string }> = {
  team_status: { collection: 'teams', idField: 'teamId' },
  field_message_receipt: { collection: 'messages', idField: 'messageId' },
};

const BACKOFF = [2_000, 5_000, 15_000, 60_000, 300_000];

export class SyncLoop {
  readonly outbox: Outbox;
  private readonly store: FieldStore;
  private readonly api: FieldApi;
  private readonly events: SyncEvents;
  private readonly now: () => Date;
  private failures = 0;
  private running = false;
  private wiped = false;
  status: SyncStatus = {
    phase: 'idle',
    pending: 0,
    conflicts: 0,
    lastSyncAt: null,
    lastError: null,
    backoffMs: 0,
  };

  constructor(
    store: FieldStore,
    api: FieldApi,
    opts: { events?: SyncEvents; now?: () => Date; outbox?: Outbox } = {},
  ) {
    this.store = store;
    this.api = api;
    this.events = opts.events ?? {};
    this.now = opts.now ?? (() => new Date());
    this.outbox = opts.outbox ?? new Outbox(store, { now: this.now });
  }

  private async emit(patch: Partial<SyncStatus>): Promise<void> {
    const all = await this.outbox.all();
    this.status = {
      ...this.status,
      ...patch,
      pending: all.filter((c) => c.status === 'on_this_phone' || c.status === 'sending').length,
      conflicts: all.filter((c) => c.status === 'conflict' || c.status === 'rejected').length,
    };
    this.events.onStatus?.(this.status);
  }

  /** One round: push, then pull. Returns what happened; never throws for transport failures. */
  async runOnce(): Promise<{
    sent: number;
    applied: number;
    conflicts: number;
    received: number;
    ok: boolean;
    wiped: boolean;
  }> {
    if (this.running || this.wiped)
      return { sent: 0, applied: 0, conflicts: 0, received: 0, ok: !this.wiped, wiped: this.wiped };
    this.running = true;
    this.resyncs = 0;
    let sent = 0;
    let applied = 0;
    let conflicts = 0;
    let received = 0;
    try {
      const deviceId = (await this.store.getMeta('device.id')) ?? undefined;
      // Push, in batches of 100, in order; stop pushing after the first transport failure.
      for (;;) {
        const batch = await this.outbox.pending(100);
        if (!batch.length) break;
        await this.emit({ phase: 'sending' });
        await this.outbox.markSending(batch.map((c) => c.id));
        let res: Awaited<ReturnType<FieldApi['postCommands']>>;
        try {
          res = await this.api.postCommands({
            ...(deviceId ? { deviceId } : {}),
            commands: batch.map((c) => ({
              id: c.id,
              kind: c.kind,
              ...(c.targetId !== undefined ? { targetId: c.targetId } : {}),
              ...(c.version !== undefined ? { version: c.version } : {}),
              body: c.body,
              clientAt: c.clientAt,
            })),
          });
        } catch (err) {
          await this.outbox.markFailed(
            batch.map((c) => c.id),
            err instanceof Error ? err.message : String(err),
          );
          return this.failed(err, { sent, applied, conflicts, received });
        }
        sent += batch.length;
        for (const r of res.results) {
          const cmd = await this.outbox.markResult(r);
          if (!cmd) continue;
          if (r.result === 'applied' || r.result === 'duplicate') {
            applied += 1;
            if (cmd.localRef)
              await this.markLocal(cmd.localRef, 'received', r.record?.version ?? null);
          } else if (r.result === 'conflict') {
            conflicts += 1;
            await this.handleConflict(cmd, r);
          } else if (cmd.localRef) await this.markLocal(cmd.localRef, 'on_this_phone', null);
        }
        if (res.device?.wipe) return this.wipe();
        if (batch.length < 100) break;
      }
      // Pull from the cursor; refresh the records named (through their authorized routes).
      await this.emit({ phase: 'receiving' });
      let cursor = Number((await this.store.getMeta('cursor')) ?? 0);
      for (;;) {
        let page: Awaited<ReturnType<FieldApi['getSync']>>;
        try {
          page = await this.api.getSync({ cursor, limit: 500, ...(deviceId ? { deviceId } : {}) });
        } catch (err) {
          const resumed = isCursorExpired(err) ? await this.resync() : null;
          if (resumed === null) return this.failed(err, { sent, applied, conflicts, received });
          cursor = resumed;
          continue;
        }
        if (page.device?.wipe) return this.wipe();
        // The latest change per record; only records newer than the phone's copy are fetched, in batches.
        const latest = new Map<string, ChangeWire>();
        for (const ch of page.changes) latest.set(`${ch.recordType}:${ch.recordId}`, ch);
        const wanted: { type: string; id: string }[] = [];
        for (const ch of latest.values()) {
          const alias = ALIASES[ch.recordType];
          const collection = RECORD_COLLECTIONS[ch.recordType];
          if (!alias && !collection) continue; // positions and anything the phone does not keep
          if (collection && ch.op === 'delete') {
            await this.store.delete(collection, ch.recordId);
            received += 1;
            continue;
          }
          if (collection) {
            const local = await this.store.get<StoredDoc & { version?: number }>(
              collection,
              ch.recordId,
            );
            if (
              local &&
              ch.version !== null &&
              local.version !== undefined &&
              local.version >= ch.version
            )
              continue;
          }
          wanted.push({ type: ch.recordType, id: ch.recordId });
        }
        for (let i = 0; i < wanted.length; i += 200) {
          let fresh: Awaited<ReturnType<FieldApi['fetchRecords']>>;
          try {
            fresh = await this.api.fetchRecords(wanted.slice(i, i + 200));
          } catch (err) {
            return this.failed(err, { sent, applied, conflicts, received });
          }
          for (const f of fresh) {
            const alias = ALIASES[f.type];
            if (alias) {
              const targetId = f.record?.[alias.idField];
              if (typeof targetId === 'string')
                await this.store.put(alias.collection, {
                  ...f.record,
                  id: targetId,
                  syncState: 'received',
                });
              continue;
            }
            const collection = RECORD_COLLECTIONS[f.type]!;
            if (f.record)
              await this.store.put(collection, { ...f.record, id: f.id, syncState: 'received' });
            else await this.store.delete(collection, f.id); // gone or no longer visible to this phone (FLD-14)
            received += 1;
          }
        }
        cursor = page.cursor;
        await this.store.setMeta('cursor', String(cursor));
        if (!page.more) break;
      }
      this.failures = 0;
      await purgePersonalData(this.store, 'after_sync');
      await this.outbox.pruneReceived(24 * 3_600_000);
      await this.emit({
        phase: 'idle',
        lastSyncAt: this.now().toISOString(),
        lastError: null,
        backoffMs: 0,
      });
      return { sent, applied, conflicts, received, ok: true, wiped: false };
    } finally {
      this.running = false;
    }
  }

  /** Once per round: a fresh area package, and its cursor to resume from. */
  private resyncs = 0;
  private async resync(): Promise<number | null> {
    if (this.resyncs > 0 || !this.events.onResync) return null;
    this.resyncs += 1;
    const fresh = await this.events.onResync().catch(() => null);
    if (fresh === null) return null;
    await this.store.setMeta('cursor', String(fresh));
    return fresh;
  }

  private async failed(
    err: unknown,
    counts: { sent: number; applied: number; conflicts: number; received: number },
  ) {
    this.failures += 1;
    const backoffMs = BACKOFF[Math.min(this.failures, BACKOFF.length) - 1]!;
    await this.emit({
      phase: 'offline',
      lastError: err instanceof Error ? err.message : String(err),
      backoffMs,
    });
    return { ...counts, ok: false, wiped: false };
  }

  private async wipe() {
    this.wiped = true;
    await purgePersonalData(this.store, 'wipe');
    this.status = {
      phase: 'wiped',
      pending: 0,
      conflicts: 0,
      lastSyncAt: this.now().toISOString(),
      lastError: null,
      backoffMs: 0,
    };
    this.events.onStatus?.(this.status);
    this.events.onWipe?.();
    return { sent: 0, applied: 0, conflicts: 0, received: 0, ok: true, wiped: true };
  }

  private async markLocal(
    ref: { collection: string; id: string },
    state: 'received' | 'on_this_phone',
    version: number | null,
  ) {
    const doc = await this.store.get<StoredDoc & { version?: number }>(ref.collection, ref.id);
    if (!doc) return;
    await this.store.put(ref.collection, {
      ...doc,
      syncState: state,
      ...(version !== null ? { version } : {}),
    });
  }

  private async handleConflict(cmd: OutboxCommand, r: CommandResultWire) {
    const current = (r.current ?? {}) as Record<string, unknown>;
    const base = cmd.localRef
      ? await this.store.get<StoredDoc>(cmd.localRef.collection, cmd.localRef.id)
      : null;
    const resolution = reconcile({ kind: cmd.kind, base, current, mine: cmd.body });
    if (resolution.kind === 'rebase') {
      // The fields the person changed did not move on the server: re-send on the current version with a new id.
      await this.outbox.resolve(cmd.id);
      await this.outbox.enqueue({
        kind: cmd.kind,
        ...(cmd.targetId !== undefined ? { targetId: cmd.targetId } : {}),
        version: resolution.version,
        body: resolution.body,
        ...(cmd.localRef ? { localRef: cmd.localRef } : {}),
      });
    } else if (resolution.kind === 'already_done' || resolution.kind === 'append_only') {
      await this.outbox.resolve(cmd.id);
    }
    if (cmd.localRef && 'version' in current) {
      const local = await this.store.get<StoredDoc>(cmd.localRef.collection, cmd.localRef.id);
      if (local)
        await this.store.put(cmd.localRef.collection, {
          ...local,
          serverCurrent: current,
          syncState: resolution.kind === 'needs_person' ? 'conflict' : local['syncState'],
        });
    }
    this.events.onConflict?.(cmd, resolution);
  }

  /** Delay before the next attempt, from the failure count (0 after success). */
  nextDelayMs(): number {
    return this.failures ? BACKOFF[Math.min(this.failures, BACKOFF.length) - 1]! : 0;
  }
}
