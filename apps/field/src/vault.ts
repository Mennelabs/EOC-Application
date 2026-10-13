/**
 * Encrypted app storage for the web build (FLD-02, FLD-13, NFR-08, ADR-0014,
 * plan §5): every record is AES-GCM encrypted in IndexedDB under a key
 * derived from the PIN (PBKDF2-SHA-256, 310,000 iterations, a random salt).
 * The PIN is never stored; a sealed verifier tells a right PIN from a wrong
 * one. Ten wrong PINs clear the app's data on this device (FLD-02: a lost
 * phone gives up nothing). The phone uses vault.native.ts (SQLCipher).
 */
import type { FieldStore, StoredDoc } from '@cg/field-core';

const DB = 'cg-field';
const OBJECTS = 'docs';
const SALT_KEY = 'cgf.salt';
const VERIFIER_KEY = 'cgf.verifier';
const FAILS_KEY = 'cgf.fails';
export const MAX_PIN_TRIES = 10;
const VERIFIER_TEXT = 'cg-field-unlocked';

function b64(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}
function unb64(text: string): Uint8Array<ArrayBuffer> {
  const s = atob(text);
  const out = new Uint8Array(new ArrayBuffer(s.length));
  for (let i = 0; i < s.length; i += 1) out[i] = s.charCodeAt(i);
  return out;
}

async function deriveKey(pin: string, salt: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(pin),
    'PBKDF2',
    false,
    ['deriveKey'],
  );
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: 310_000, hash: 'SHA-256' },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

async function seal(key: CryptoKey, value: unknown): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    new TextEncoder().encode(JSON.stringify(value)),
  );
  return `${b64(iv)}.${b64(new Uint8Array(ct))}`;
}

async function open<T>(key: CryptoKey, blob: string): Promise<T> {
  const [iv, ct] = blob.split('.');
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: unb64(iv ?? '') },
    key,
    unb64(ct ?? ''),
  );
  return JSON.parse(new TextDecoder().decode(plain)) as T;
}

function idb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => {
      const store = req.result.createObjectStore(OBJECTS, { keyPath: 'k' });
      store.createIndex('c', 'c');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('indexeddb'));
  });
}

function tx<T>(
  db: IDBDatabase,
  mode: IDBTransactionMode,
  fn: (s: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = db.transaction(OBJECTS, mode);
    const req = fn(t.objectStore(OBJECTS));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('indexeddb'));
  });
}

interface Row {
  k: string;
  c: string;
  v: string;
}

/** A FieldStore over IndexedDB where every value is sealed with the PIN-derived key. */
class SealedStore implements FieldStore {
  private readonly db: IDBDatabase;
  private readonly key: CryptoKey;
  constructor(db: IDBDatabase, key: CryptoKey) {
    this.db = db;
    this.key = key;
  }
  async get<T extends object = StoredDoc>(collection: string, id: string): Promise<T | null> {
    const row = await tx<Row | undefined>(this.db, 'readonly', (s) => s.get(`${collection}/${id}`));
    return row ? open<T>(this.key, row.v) : null;
  }
  async put<T extends StoredDoc>(collection: string, doc: T): Promise<void> {
    const v = await seal(this.key, doc);
    await tx(this.db, 'readwrite', (s) =>
      s.put({ k: `${collection}/${doc.id}`, c: collection, v }),
    );
  }
  async delete(collection: string, id: string): Promise<void> {
    await tx(this.db, 'readwrite', (s) => s.delete(`${collection}/${id}`));
  }
  async list<T extends object = StoredDoc>(
    collection: string,
    filter?: (doc: T) => boolean,
  ): Promise<T[]> {
    const rows = await tx<Row[]>(this.db, 'readonly', (s) => s.index('c').getAll(collection));
    const docs = await Promise.all(rows.map((r) => open<T>(this.key, r.v)));
    return filter ? docs.filter(filter) : docs;
  }
  async clear(collection: string): Promise<void> {
    const keys = await tx<IDBValidKey[]>(this.db, 'readonly', (s) =>
      s.index('c').getAllKeys(collection),
    );
    for (const k of keys) await tx(this.db, 'readwrite', (s) => s.delete(k));
  }
  async collections(): Promise<string[]> {
    const rows = await tx<Row[]>(this.db, 'readonly', (s) => s.getAll());
    return [...new Set(rows.map((r) => r.c).filter((c) => c !== '__meta'))];
  }
  async getMeta(key: string): Promise<string | null> {
    const doc = await this.get<{ id: string; value: string }>('__meta', key);
    return doc?.value ?? null;
  }
  async setMeta(key: string, value: string | null): Promise<void> {
    if (value === null) await this.delete('__meta', key);
    else await this.put('__meta', { id: key, value });
  }
}

export async function hasPin(): Promise<boolean> {
  return !!localStorage.getItem(VERIFIER_KEY);
}

export async function biometricsAvailable(): Promise<boolean> {
  return false; // the web build is for tests; the phone offers fingerprint or face
}

/** First use: a new salt and verifier under the chosen PIN. */
export async function createVault(pin: string): Promise<FieldStore> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await deriveKey(pin, salt);
  localStorage.setItem(SALT_KEY, b64(salt));
  localStorage.setItem(VERIFIER_KEY, await seal(key, VERIFIER_TEXT));
  localStorage.setItem(FAILS_KEY, '0');
  return new SealedStore(await idb(), key);
}

export type UnlockResult =
  { ok: true; store: FieldStore } | { ok: false; triesLeft: number; wiped: boolean };

export async function unlockVault(pin: string): Promise<UnlockResult> {
  const saltText = localStorage.getItem(SALT_KEY);
  const verifier = localStorage.getItem(VERIFIER_KEY);
  if (!saltText || !verifier) return { ok: false, triesLeft: 0, wiped: true };
  const key = await deriveKey(pin, unb64(saltText));
  try {
    if ((await open<string>(key, verifier)) !== VERIFIER_TEXT) throw new Error('verifier');
    localStorage.setItem(FAILS_KEY, '0');
    return { ok: true, store: new SealedStore(await idb(), key) };
  } catch {
    const fails = Number(localStorage.getItem(FAILS_KEY) ?? '0') + 1;
    localStorage.setItem(FAILS_KEY, String(fails));
    if (fails >= MAX_PIN_TRIES) {
      await wipeVault();
      return { ok: false, triesLeft: 0, wiped: true };
    }
    return { ok: false, triesLeft: MAX_PIN_TRIES - fails, wiped: false };
  }
}

export async function unlockWithBiometrics(): Promise<FieldStore | null> {
  return null;
}

/** FLD-02: remote wipe or too many wrong PINs clears only this app's data. */
export async function wipeVault(): Promise<void> {
  for (const k of [SALT_KEY, VERIFIER_KEY, FAILS_KEY]) localStorage.removeItem(k);
  await new Promise<void>((resolve) => {
    const req = indexedDB.deleteDatabase(DB);
    req.onsuccess = () => resolve();
    req.onerror = () => resolve();
    req.onblocked = () => resolve();
  });
}

export function installId(): string {
  const k = 'cgf.install';
  let id = localStorage.getItem(k);
  if (!id) {
    id = `web-${crypto.randomUUID()}`;
    localStorage.setItem(k, id);
  }
  return id;
}
