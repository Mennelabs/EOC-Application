/** CHN-07, ACC-41: what the device keeps is encrypted and clearable. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { decryptJson, encryptJson, localStore } from '../src/intake/storage.ts';

class MemoryStorage implements Storage {
  private m = new Map<string, string>();
  get length() {
    return this.m.size;
  }
  clear() {
    this.m.clear();
  }
  getItem(k: string) {
    return this.m.get(k) ?? null;
  }
  key(i: number) {
    return [...this.m.keys()][i] ?? null;
  }
  removeItem(k: string) {
    this.m.delete(k);
  }
  setItem(k: string, v: string) {
    this.m.set(k, v);
  }
}

describe('encrypted local store', () => {
  const g = globalThis as unknown as { localStorage?: Storage; sessionStorage?: Storage };
  beforeEach(() => {
    g.localStorage = new MemoryStorage();
    g.sessionStorage = new MemoryStorage();
  });
  afterEach(() => {
    delete g.localStorage;
    delete g.sessionStorage;
  });

  it('round-trips JSON under AES-GCM and never stores the clear text', async () => {
    const store = localStore();
    await store.set('flow', { answers: { contact: { phone: '+13145550199' } } });
    const raw = g.localStorage!.getItem('cg.flow')!;
    expect(raw).not.toContain('3145550199');
    expect(await store.get<{ answers: { contact: { phone: string } } }>('flow')).toEqual({
      answers: { contact: { phone: '+13145550199' } },
    });
  });

  it('is unreadable once the session key is gone, and clearAll removes everything', async () => {
    const store = localStore();
    await store.set('flow', { a: 1 });
    g.sessionStorage!.removeItem('cg.key');
    const fresh = localStore();
    expect(await fresh.get('flow')).toBeNull();
    await fresh.set('outbox', [1]);
    fresh.clearAll();
    expect(g.localStorage!.length).toBe(0);
    expect(g.sessionStorage!.getItem('cg.key')).toBeNull();
  });

  it('a kiosk keeps its key on the device so unsent reports survive a restart (CHN-07)', async () => {
    const store = localStore({ persistentKey: true });
    await store.set('outbox', [{ x: 1 }]);
    expect(g.localStorage!.getItem('cg.key')).not.toBeNull();
    g.sessionStorage = new MemoryStorage(); // new browser session
    expect(await localStore({ persistentKey: true }).get('outbox')).toEqual([{ x: 1 }]);
  });

  it('rejects tampered ciphertext', async () => {
    const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, [
      'encrypt',
      'decrypt',
    ]);
    const blob = await encryptJson({ ok: true }, key);
    expect(await decryptJson(blob, key)).toEqual({ ok: true });
    const [iv, ct] = blob.split('.');
    expect(await decryptJson(`${iv}.${ct!.slice(0, -4)}AAAA`, key)).toBeNull();
  });
});
