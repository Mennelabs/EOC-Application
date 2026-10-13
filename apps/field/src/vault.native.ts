/**
 * Encrypted app storage on the phone (FLD-02, FLD-13, NFR-08, ADR-0014):
 * SQLite with SQLCipher (expo-sqlite, `useSQLCipher` in app.json). The
 * database key is random, kept in the Keychain or Keystore
 * (expo-secure-store) and handed over only after the PIN or the phone's
 * fingerprint or face check (expo-local-authentication). The PIN itself is
 * stored only as a salted hash. Ten wrong PINs clear the app's data;
 * nothing else on the phone is touched.
 */
import * as Crypto from 'expo-crypto';
import * as LocalAuthentication from 'expo-local-authentication';
import * as SecureStore from 'expo-secure-store';
import * as SQLite from 'expo-sqlite';
import type { FieldStore, StoredDoc } from '@cg/field-core';

export const MAX_PIN_TRIES = 10;
const DB_NAME = 'cg-field.db';
const KEY = 'cgf.dbkey';
const PIN_HASH = 'cgf.pinhash';
const PIN_SALT = 'cgf.pinsalt';
const FAILS = 'cgf.fails';
const INSTALL = 'cgf.install';

const hex = (bytes: Uint8Array) => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');

async function pinHash(pin: string, salt: string): Promise<string> {
  // Many rounds of SHA-256 over salt and PIN; the Keystore protects the hash at rest.
  let h = `${salt}:${pin}`;
  for (let i = 0; i < 20_000; i += 1)
    h = await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, h);
  return h;
}

class SqlStore implements FieldStore {
  private readonly db: SQLite.SQLiteDatabase;
  constructor(db: SQLite.SQLiteDatabase) {
    this.db = db;
  }
  async get<T extends object = StoredDoc>(collection: string, id: string): Promise<T | null> {
    const row = await this.db.getFirstAsync<{ json: string }>(
      'select json from docs where collection = ? and id = ?',
      collection,
      id,
    );
    return row ? (JSON.parse(row.json) as T) : null;
  }
  async put<T extends StoredDoc>(collection: string, doc: T): Promise<void> {
    await this.db.runAsync(
      'insert or replace into docs (collection, id, json) values (?, ?, ?)',
      collection,
      doc.id,
      JSON.stringify(doc),
    );
  }
  async delete(collection: string, id: string): Promise<void> {
    await this.db.runAsync('delete from docs where collection = ? and id = ?', collection, id);
  }
  async list<T extends object = StoredDoc>(
    collection: string,
    filter?: (doc: T) => boolean,
  ): Promise<T[]> {
    const rows = await this.db.getAllAsync<{ json: string }>(
      'select json from docs where collection = ?',
      collection,
    );
    const docs = rows.map((r) => JSON.parse(r.json) as T);
    return filter ? docs.filter(filter) : docs;
  }
  async clear(collection: string): Promise<void> {
    await this.db.runAsync('delete from docs where collection = ?', collection);
  }
  async collections(): Promise<string[]> {
    const rows = await this.db.getAllAsync<{ collection: string }>(
      'select distinct collection from docs',
    );
    return rows.map((r) => r.collection);
  }
  async getMeta(key: string): Promise<string | null> {
    const row = await this.db.getFirstAsync<{ value: string }>(
      'select value from meta where key = ?',
      key,
    );
    return row?.value ?? null;
  }
  async setMeta(key: string, value: string | null): Promise<void> {
    if (value === null) await this.db.runAsync('delete from meta where key = ?', key);
    else
      await this.db.runAsync('insert or replace into meta (key, value) values (?, ?)', key, value);
  }
}

async function openDb(): Promise<FieldStore> {
  let key = await SecureStore.getItemAsync(KEY);
  if (!key) {
    key = hex(Crypto.getRandomBytes(32));
    await SecureStore.setItemAsync(KEY, key, {
      keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
    });
  }
  const db = await SQLite.openDatabaseAsync(DB_NAME);
  await db.execAsync(`PRAGMA key = "x'${key}'";`);
  await db.execAsync(
    'create table if not exists docs (collection text not null, id text not null, json text not null, primary key (collection, id));' +
      'create table if not exists meta (key text primary key, value text not null);',
  );
  return new SqlStore(db);
}

export async function hasPin(): Promise<boolean> {
  return !!(await SecureStore.getItemAsync(PIN_HASH));
}

export async function biometricsAvailable(): Promise<boolean> {
  return (
    (await LocalAuthentication.hasHardwareAsync()) && (await LocalAuthentication.isEnrolledAsync())
  );
}

export async function createVault(pin: string): Promise<FieldStore> {
  const salt = hex(Crypto.getRandomBytes(16));
  await SecureStore.setItemAsync(PIN_SALT, salt);
  await SecureStore.setItemAsync(PIN_HASH, await pinHash(pin, salt));
  await SecureStore.setItemAsync(FAILS, '0');
  return openDb();
}

export type UnlockResult =
  { ok: true; store: FieldStore } | { ok: false; triesLeft: number; wiped: boolean };

export async function unlockVault(pin: string): Promise<UnlockResult> {
  const salt = await SecureStore.getItemAsync(PIN_SALT);
  const stored = await SecureStore.getItemAsync(PIN_HASH);
  if (!salt || !stored) return { ok: false, triesLeft: 0, wiped: true };
  if ((await pinHash(pin, salt)) === stored) {
    await SecureStore.setItemAsync(FAILS, '0');
    return { ok: true, store: await openDb() };
  }
  const fails = Number((await SecureStore.getItemAsync(FAILS)) ?? '0') + 1;
  await SecureStore.setItemAsync(FAILS, String(fails));
  if (fails >= MAX_PIN_TRIES) {
    await wipeVault();
    return { ok: false, triesLeft: 0, wiped: true };
  }
  return { ok: false, triesLeft: MAX_PIN_TRIES - fails, wiped: false };
}

export async function unlockWithBiometrics(): Promise<FieldStore | null> {
  if (!(await hasPin()) || !(await biometricsAvailable())) return null;
  const r = await LocalAuthentication.authenticateAsync({ disableDeviceFallback: false });
  return r.success ? openDb() : null;
}

export async function wipeVault(): Promise<void> {
  for (const k of [KEY, PIN_HASH, PIN_SALT, FAILS]) await SecureStore.deleteItemAsync(k);
  await SQLite.deleteDatabaseAsync(DB_NAME).catch(() => undefined);
}

let install: string | null = null;
export function installId(): string {
  if (install) return install;
  install = SecureStore.getItem(INSTALL);
  if (!install) {
    install = `native-${Crypto.randomUUID()}`;
    SecureStore.setItem(INSTALL, install);
  }
  return install;
}
