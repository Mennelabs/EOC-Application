/**
 * Encrypted local storage for answers in progress and the outbox (CHN-07,
 * ACC-41, SCL-06). Data is AES-GCM encrypted with a key that lives only in
 * sessionStorage, so closing the tab makes what remains unreadable; "Clear
 * my answers" removes both. Works without any of it (private mode): the
 * flow then keeps state in memory only.
 */
const KEY_NAME = 'cg.key';
const PREFIX = 'cg.';

function available(store: Storage | undefined): store is Storage {
  try {
    if (!store) return false;
    const probe = '__cg_probe__';
    store.setItem(probe, '1');
    store.removeItem(probe);
    return true;
  } catch {
    return false;
  }
}

function bytesToBase64(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function base64ToBytes(text: string): Uint8Array<ArrayBuffer> {
  const s = atob(text);
  const out = new Uint8Array(new ArrayBuffer(s.length));
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

function keyStore(persistent: boolean): Storage | undefined {
  // Residents: the key dies with the tab (shared devices, ACC-41). Kiosks: the organisation's device keeps it (CHN-07).
  const s = persistent
    ? typeof localStorage === 'undefined'
      ? undefined
      : localStorage
    : typeof sessionStorage === 'undefined'
      ? undefined
      : sessionStorage;
  return available(s) ? s : undefined;
}

async function sessionKey(create: boolean, persistent: boolean): Promise<CryptoKey | null> {
  const session = keyStore(persistent);
  if (!session || !globalThis.crypto?.subtle) return null;
  let raw = session.getItem(KEY_NAME);
  if (!raw) {
    if (!create) return null;
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    raw = bytesToBase64(bytes);
    session.setItem(KEY_NAME, raw);
  }
  return crypto.subtle.importKey('raw', base64ToBytes(raw), 'AES-GCM', false, [
    'encrypt',
    'decrypt',
  ]);
}

export async function encryptJson(value: unknown, key: CryptoKey): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = new TextEncoder().encode(JSON.stringify(value));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, data));
  return `${bytesToBase64(iv)}.${bytesToBase64(ct)}`;
}

export async function decryptJson<T>(blob: string, key: CryptoKey): Promise<T | null> {
  const [ivText, ctText] = blob.split('.');
  if (!ivText || !ctText) return null;
  try {
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: base64ToBytes(ivText) },
      key,
      base64ToBytes(ctText),
    );
    return JSON.parse(new TextDecoder().decode(plain)) as T;
  } catch {
    return null; // another session's key, or tampered: treat as nothing saved
  }
}

export interface LocalStore {
  get<T>(name: string): Promise<T | null>;
  set(name: string, value: unknown): Promise<void>;
  remove(name: string): void;
  /** Removes everything this app saved on the device (ACC-41). */
  clearAll(): void;
}

export function localStore(options: { persistentKey?: boolean } = {}): LocalStore {
  const persistent = options.persistentKey ?? false;
  const local = typeof localStorage === 'undefined' ? undefined : localStorage;
  const memory = new Map<string, unknown>();
  return {
    async get<T>(name: string): Promise<T | null> {
      if (memory.has(name)) return memory.get(name) as T;
      if (!available(local)) return null;
      const blob = local.getItem(PREFIX + name);
      if (!blob) return null;
      const key = await sessionKey(false, persistent);
      if (!key) return null;
      return decryptJson<T>(blob, key);
    },
    async set(name, value) {
      memory.set(name, value);
      if (!available(local)) return;
      const key = await sessionKey(true, persistent);
      if (!key) return;
      local.setItem(PREFIX + name, await encryptJson(value, key));
    },
    remove(name) {
      memory.delete(name);
      if (available(local)) local.removeItem(PREFIX + name);
    },
    clearAll() {
      memory.clear();
      if (available(local))
        for (let i = local.length - 1; i >= 0; i--) {
          const k = local.key(i);
          if (k?.startsWith(PREFIX)) local.removeItem(k);
        }
      for (const persistentKey of [false, true]) keyStore(persistentKey)?.removeItem(KEY_NAME);
    },
  };
}
