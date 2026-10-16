/**
 * The outbox (FLD-13, NFR-07, NFR-08, AC-00C): everything the volunteer does
 * is a command saved on the phone first, with its own UUID, and sent in
 * order. Every record shows "On this phone", "Sending" or "Received"
 * (FLD-13). A command is never dropped by the phone: it leaves the outbox
 * only when the server has answered for its id (applied, duplicate,
 * conflict or rejected). Conflicts and rejections stay visible until the
 * person deals with them.
 */
import type { FieldStore, StoredDoc } from './storage.ts';

export type OutboxStatus = 'on_this_phone' | 'sending' | 'received' | 'conflict' | 'rejected';

export interface OutboxCommand extends StoredDoc {
  id: string;
  kind: string;
  targetId?: string;
  version?: number;
  body: Record<string, unknown>;
  clientAt: string;
  /** Monotonic order on this phone. */
  seq: number;
  status: OutboxStatus;
  attempts: number;
  lastError?: string;
  /** Filled from the server's answer. */
  record?: { type: string | null; id: string | null; version: number | null } | null;
  current?: unknown;
  /** The local record this command belongs to (for the status badge). */
  localRef?: { collection: string; id: string };
}

export const OUTBOX = 'outbox';

/** Append-only facts: a replay or a conflict never loses them, the server records each once by id (plan §3). */
export const APPEND_ONLY_KINDS = new Set([
  'position.batch',
  'safety_alert.raise',
  'hazard.report',
  'mission.narrative',
  'field_message.receipt',
  'check_in.start',
  'check_in.end',
  'team.status',
  // BRD:FR-03.05: what the phone allows, with its time; the server keeps the newest.
  'check_in.location_permission',
]);

export class Outbox {
  private readonly store: FieldStore;
  private readonly now: () => Date;
  private readonly newId: () => string;

  constructor(store: FieldStore, opts: { now?: () => Date; newId?: () => string } = {}) {
    this.store = store;
    this.now = opts.now ?? (() => new Date());
    this.newId = opts.newId ?? (() => globalThis.crypto.randomUUID());
  }

  async enqueue(input: {
    kind: string;
    targetId?: string;
    version?: number;
    body: Record<string, unknown>;
    localRef?: { collection: string; id: string };
    id?: string;
  }): Promise<OutboxCommand> {
    const seqText = await this.store.getMeta('outbox.seq');
    const seq = (seqText ? Number(seqText) : 0) + 1;
    await this.store.setMeta('outbox.seq', String(seq));
    const cmd: OutboxCommand = {
      id: input.id ?? this.newId(),
      kind: input.kind,
      ...(input.targetId !== undefined ? { targetId: input.targetId } : {}),
      ...(input.version !== undefined ? { version: input.version } : {}),
      body: input.body,
      clientAt: this.now().toISOString(),
      seq,
      status: 'on_this_phone',
      attempts: 0,
      ...(input.localRef ? { localRef: input.localRef } : {}),
    };
    await this.store.put(OUTBOX, cmd);
    return cmd;
  }

  /** In order; `sending` ones are included so a batch cut off mid-way is re-sent with the same ids (the server answers duplicate). */
  async pending(limit = 100): Promise<OutboxCommand[]> {
    const all = await this.store.list<OutboxCommand>(
      OUTBOX,
      (c) => c.status === 'on_this_phone' || c.status === 'sending',
    );
    return all.sort((a, b) => a.seq - b.seq).slice(0, limit);
  }

  async all(): Promise<OutboxCommand[]> {
    return (await this.store.list<OutboxCommand>(OUTBOX)).sort((a, b) => a.seq - b.seq);
  }

  async get(id: string): Promise<OutboxCommand | null> {
    return this.store.get<OutboxCommand>(OUTBOX, id);
  }

  async markSending(ids: readonly string[]): Promise<void> {
    for (const id of ids) {
      const c = await this.store.get<OutboxCommand>(OUTBOX, id);
      if (c) await this.store.put(OUTBOX, { ...c, status: 'sending', attempts: c.attempts + 1 });
    }
  }

  /** A transport failure: back to "On this phone"; the ids are kept so the next send replays them. */
  async markFailed(ids: readonly string[], error: string): Promise<void> {
    for (const id of ids) {
      const c = await this.store.get<OutboxCommand>(OUTBOX, id);
      if (c) await this.store.put(OUTBOX, { ...c, status: 'on_this_phone', lastError: error });
    }
  }

  async markResult(result: {
    id: string;
    result: 'applied' | 'duplicate' | 'conflict' | 'rejected';
    status: number;
    record: { type: string | null; id: string | null; version: number | null } | null;
    current?: unknown;
    error?: { code: string; message: string };
  }): Promise<OutboxCommand | null> {
    const c = await this.store.get<OutboxCommand>(OUTBOX, result.id);
    if (!c) return null;
    const next: OutboxCommand = {
      ...c,
      status:
        result.result === 'applied' || result.result === 'duplicate' ? 'received' : result.result,
      record: result.record,
      ...(result.current !== undefined ? { current: result.current } : {}),
      ...(result.error ? { lastError: `${result.error.code}: ${result.error.message}` } : {}),
    };
    await this.store.put(OUTBOX, next);
    return next;
  }

  /** Received commands can go once the records they touched are refreshed; conflicts and rejections stay until resolved. */
  async pruneReceived(olderThanMs: number): Promise<number> {
    const cutoff = this.now().getTime() - olderThanMs;
    let n = 0;
    for (const c of await this.store.list<OutboxCommand>(OUTBOX, (x) => x.status === 'received')) {
      if (new Date(c.clientAt).getTime() < cutoff) {
        await this.store.delete(OUTBOX, c.id);
        n += 1;
      }
    }
    return n;
  }

  /** The person dealt with a conflict or rejection (re-did it or let it go). */
  async resolve(id: string): Promise<void> {
    await this.store.delete(OUTBOX, id);
  }

  /** The badge for a local record: the worst status among its commands (FLD-13). */
  async statusOf(localRef: { collection: string; id: string }): Promise<OutboxStatus | 'received'> {
    const cmds = await this.store.list<OutboxCommand>(
      OUTBOX,
      (c) => c.localRef?.collection === localRef.collection && c.localRef.id === localRef.id,
    );
    const rank: Record<OutboxStatus, number> = {
      received: 0,
      sending: 1,
      on_this_phone: 2,
      rejected: 3,
      conflict: 4,
    };
    let worst: OutboxStatus = 'received';
    for (const c of cmds) if (rank[c.status] > rank[worst]) worst = c.status;
    return worst;
  }
}
