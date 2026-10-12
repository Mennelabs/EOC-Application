import { describe, expect, it } from 'vitest';
import { FieldCrypto, normalisePhone } from '../src/field.ts';
import { InMemoryKeyService } from '../src/keys.ts';
import { MemoryKeyStore } from '../src/store.ts';

const A = '0190000a-0000-4000-8000-00000000000a';
const B = '0190000b-0000-4000-8000-00000000000b';

function setup() {
  const keys = new InMemoryKeyService();
  const store = new MemoryKeyStore();
  return { fc: new FieldCrypto(keys, store), keys, store };
}

describe('FieldCrypto (SEC-10, ADR-0009)', () => {
  it('round-trips and never repeats a ciphertext', async () => {
    const { fc } = setup();
    const a = await fc.encrypt(A, '+13145550142');
    const b = await fc.encrypt(A, '+13145550142');
    expect(a.equals(b)).toBe(false);
    expect(await fc.decrypt(A, a)).toBe('+13145550142');
    expect(a.toString('latin1')).not.toContain('5550142');
  });

  it('creates and stores one wrapped data key per tenant on first use', async () => {
    const { fc, store } = setup();
    await fc.encrypt(A, 'x');
    await fc.encrypt(A, 'y');
    await fc.encrypt(B, 'z');
    expect(await store.getActive(A)).toMatchObject({ version: 1 });
    expect(await store.getActive(B)).toMatchObject({ version: 1 });
    expect((await store.getActive(A))!.wrapped).not.toBe((await store.getActive(B))!.wrapped);
  });

  it('a ciphertext from one tenant cannot be read as another (AAD binds the tenant)', async () => {
    const { fc } = setup();
    const blob = await fc.encrypt(A, 'secret');
    await fc.encrypt(B, 'warm up B');
    await expect(fc.decrypt(B, blob)).rejects.toThrow();
  });

  it('detects tampering', async () => {
    const { fc } = setup();
    const blob = await fc.encrypt(A, 'secret');
    const tampered = Buffer.from(blob);
    const last = tampered.length - 1;
    tampered[last] = (tampered[last] ?? 0) ^ 0x01;
    await expect(fc.decrypt(A, tampered)).rejects.toThrow();
  });

  it('survives a process restart: keys are unwrapped from the store, not the cache', async () => {
    const keys = new InMemoryKeyService();
    const store = new MemoryKeyStore();
    const blob = await new FieldCrypto(keys, store).encrypt(A, 'persisted');
    const fresh = new FieldCrypto(keys, store); // same key service + store, empty cache
    expect(await fresh.decrypt(A, blob)).toBe('persisted');
  });

  it('blind indexes are deterministic per tenant and purpose, and differ across tenants', async () => {
    const { fc } = setup();
    const one = await fc.blindIndex(A, 'phone', '+13145550142');
    const two = await fc.blindIndex(A, 'phone', '+13145550142');
    const other = await fc.blindIndex(B, 'phone', '+13145550142');
    const purpose = await fc.blindIndex(A, 'email', '+13145550142');
    expect(one.equals(two)).toBe(true);
    expect(one.equals(other)).toBe(false);
    expect(one.equals(purpose)).toBe(false);
  });
});

describe('normalisePhone', () => {
  it('produces one form for the same number', () => {
    expect(normalisePhone('(314) 555-0142')).toBe('+13145550142');
    expect(normalisePhone('314.555.0142')).toBe('+13145550142');
    expect(normalisePhone('+1 314 555 0142')).toBe('+13145550142');
  });
});
