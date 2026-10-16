/** ACC-39, AC-11B: one report per execution id; retries with backoff; honest states. */
import { describe, expect, it } from 'vitest';
import { ApiFailure, Offline } from '../src/api/public.ts';
import { backoffMs, Outbox } from '../src/intake/outbox.ts';
import type { LocalStore } from '../src/intake/storage.ts';
import type { SubmissionBody } from '../src/api/public.ts';

function memoryStore(): LocalStore {
  const m = new Map<string, unknown>();
  return {
    async get<T>(n: string) {
      return (m.get(n) as T) ?? null;
    },
    async set(n, v) {
      m.set(n, structuredClone(v));
    },
    remove(n) {
      m.delete(n);
    },
    clearAll() {
      m.clear();
    },
  };
}

const body = (id: string): SubmissionBody => ({
  executionId: id,
  channel: 'web',
  language: 'en',
  graphKey: 'g',
  graphVersion: 1,
  relationship: 'own_home',
  answers: {},
  needs: [],
  consent: {},
  photoIds: [],
  afterSubmission: {},
  smsOptIn: false,
  aiAssisted: false,
});

describe('outbox', () => {
  it('backs off 2 s, 4 s, 8 s … and caps at a minute', () => {
    expect([1, 2, 3, 4, 10].map(backoffMs)).toEqual([2000, 4000, 8000, 16000, 60000]);
  });

  it('sends once per execution id and reports received', async () => {
    const calls: string[] = [];
    const outbox = new Outbox(memoryStore(), async (_t, _e, b) => {
      calls.push(b.executionId);
      return { referenceCode: 'KXMR-4827', status: 'received', verificationSuggested: false };
    });
    await outbox.load();
    await outbox.add('county', 'westwind', body('a'));
    await outbox.add('county', 'westwind', body('a'));
    await outbox.flush();
    expect(calls).toEqual(['a']);
    expect(outbox.find('a')?.state).toBe('received');
    expect(outbox.find('a')?.receipt?.referenceCode).toBe('KXMR-4827');
  });

  it('keeps an offline report as not sent and retries later; a permanent refusal stops retrying with the reason', async () => {
    let attempts = 0;
    const outbox = new Outbox(memoryStore(), async (_t, _e, b) => {
      attempts++;
      if (b.executionId === 'off') throw new Offline();
      throw new ApiFailure(400, {
        code: 'validation_failed',
        message: 'Some answers need another look.',
        fields: [],
        retryable: false,
      });
    });
    await outbox.load();
    await outbox.add('county', 'westwind', body('off'));
    await outbox.add('county', 'westwind', body('bad'));
    await outbox.flush();
    const off = outbox.find('off')!;
    expect(off.state).toBe('failed');
    expect(off.final).toBeFalsy();
    expect(off.lastError).toBe('offline');
    // AC-00D: no receipt (no reference code) for a save that failed; the answers stay on the device.
    expect(off.receipt).toBeUndefined();
    expect(off.body).toEqual(body('off'));
    expect(off.nextTryAt).toBeGreaterThan(Date.now());
    const bad = outbox.find('bad')!;
    expect(bad.final).toBe(true);
    expect(bad.lastError).toContain('another look');
    await outbox.flush();
    expect(attempts).toBe(2); // neither retried yet: one waits for its backoff, the other is final
  });

  it('restores from the device and treats an interrupted "sending" as not sent', async () => {
    const store = memoryStore();
    await store.set('outbox', [
      { tenant: 'c', event: 'e', body: body('x'), state: 'sending', attempts: 1, nextTryAt: 0 },
    ]);
    const outbox = new Outbox(store, async () => ({
      referenceCode: 'ABCD-2345',
      status: 'received',
      verificationSuggested: false,
    }));
    await outbox.load();
    expect(outbox.find('x')?.state).toBe('not_sent');
    await outbox.flush();
    expect(outbox.find('x')?.state).toBe('received');
    await outbox.forget('x');
    expect(outbox.all()).toHaveLength(0);
  });
});
