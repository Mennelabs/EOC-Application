/**
 * The device outbox (ACC-39, AC-11B, CHN-07): a report is "Not sent yet"
 * until the server says "received"; sending retries with backoff and comes
 * back when the connection returns; one report per execution id, so a retry
 * never makes a duplicate. Never tells the resident a draft was received.
 */
import {
  ApiFailure,
  Offline,
  submit,
  type SubmissionBody,
  type SubmissionReceipt,
} from '../api/public.ts';
import type { LocalStore } from './storage.ts';

export type OutboxState = 'not_sent' | 'sending' | 'received' | 'failed';

export interface OutboxItem {
  tenant: string;
  event: string;
  body: SubmissionBody;
  state: OutboxState;
  attempts: number;
  nextTryAt: number;
  receipt?: SubmissionReceipt;
  lastError?: string;
  /** A permanent refusal (validation, too many reports): stop retrying and show the reason. */
  final?: boolean;
}

const NAME = 'outbox';

/** 2 s, 4 s, 8 s … up to a minute between tries (ACC-39). */
export function backoffMs(attempt: number): number {
  return Math.min(60_000, 2000 * 2 ** Math.max(0, attempt - 1));
}

export class Outbox {
  private readonly store: LocalStore;
  private items: OutboxItem[] = [];
  private listeners = new Set<() => void>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly send: typeof submit;

  constructor(store: LocalStore, send: typeof submit = submit) {
    this.store = store;
    this.send = send;
  }

  async load(): Promise<void> {
    this.items = (await this.store.get<OutboxItem[]>(NAME)) ?? [];
    for (const i of this.items) if (i.state === 'sending') i.state = 'not_sent';
    this.schedule();
  }

  all(): readonly OutboxItem[] {
    return this.items;
  }

  find(executionId: string): OutboxItem | undefined {
    return this.items.find((i) => i.body.executionId === executionId);
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  async add(tenant: string, event: string, body: SubmissionBody): Promise<void> {
    if (this.find(body.executionId)) return;
    this.items.push({ tenant, event, body, state: 'not_sent', attempts: 0, nextTryAt: 0 });
    await this.persist();
    void this.flush();
  }

  /** Drops delivered items the resident is done with (shared devices, ACC-41). */
  async forget(executionId: string): Promise<void> {
    this.items = this.items.filter((i) => i.body.executionId !== executionId);
    await this.persist();
  }

  async flush(): Promise<void> {
    const now = Date.now();
    for (const item of this.items) {
      if (item.state === 'received' || item.final || item.state === 'sending') continue;
      if (item.nextTryAt > now) continue;
      item.state = 'sending';
      this.notify();
      try {
        item.receipt = await this.send(item.tenant, item.event, item.body);
        item.state = 'received';
        delete item.lastError;
      } catch (err) {
        item.attempts += 1;
        item.state = 'failed';
        if (err instanceof ApiFailure) {
          item.lastError = err.message;
          item.final = !err.envelope.retryable;
        } else if (err instanceof Offline) {
          item.lastError = 'offline';
        } else {
          item.lastError = err instanceof Error ? err.message : String(err);
        }
        item.nextTryAt = Date.now() + backoffMs(item.attempts);
      }
      await this.persist();
    }
    this.schedule();
  }

  private schedule(): void {
    if (this.timer) clearTimeout(this.timer);
    const pending = this.items.filter((i) => i.state !== 'received' && !i.final);
    if (pending.length === 0) return;
    const next = Math.max(0, Math.min(...pending.map((i) => i.nextTryAt)) - Date.now());
    this.timer = setTimeout(() => void this.flush(), next + 50);
  }

  private async persist(): Promise<void> {
    await this.store.set(NAME, this.items);
    this.notify();
  }

  private notify(): void {
    for (const fn of this.listeners) fn();
  }
}
