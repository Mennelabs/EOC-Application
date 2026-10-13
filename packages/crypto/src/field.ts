/**
 * Field-level encryption (SEC-10): AES-256-GCM with a per-tenant data key,
 * envelope-wrapped by the key service. Blob layout, all binary:
 *
 *   0x01 | key version (uint16 BE) | iv (12) | auth tag (16) | ciphertext
 *
 * The key version lets a tenant rotate keys without re-encrypting history.
 * Blind indexes (HMAC-SHA256 under a key derived from the data key) allow
 * exact-match lookups such as "find the record with this phone number"
 * (FL-02) without storing the value in clear.
 */
import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes } from 'node:crypto';
import { type KeyService, kekName } from './keys.ts';

export interface TenantKeyRecord {
  version: number;
  wrapped: string;
}

/** Storage of wrapped data keys (cg.tenant_key). */
export interface TenantKeyStore {
  getActive(tenantId: string): Promise<TenantKeyRecord | null>;
  get(tenantId: string, version: number): Promise<TenantKeyRecord | null>;
  insert(tenantId: string, record: TenantKeyRecord & { kekName: string }): Promise<void>;
}

const VERSION_BYTE = 0x01;
const IV_BYTES = 12;
const TAG_BYTES = 16;

export class FieldCrypto {
  private readonly cache = new Map<string, Buffer>(); // `${tenant}:${version}` → data key
  /**
   * Which version is active per tenant, for a short while. Encryption runs
   * inside request and job transactions; without this every encrypt would
   * take a second database connection for the key record, and enough of
   * them at once can exhaust the pool while each holds the first (SEC-10).
   * A rotated key is picked up within the TTL; older versions stay readable.
   */
  private readonly active = new Map<string, { version: number; until: number }>();

  private readonly keys: KeyService;
  private readonly store: TenantKeyStore;
  private readonly activeTtlMs: number;

  constructor(keys: KeyService, store: TenantKeyStore, opts: { activeTtlMs?: number } = {}) {
    this.keys = keys;
    this.store = store;
    this.activeTtlMs = opts.activeTtlMs ?? 60_000;
  }

  private cacheKey(tenantId: string, version: number): string {
    return `${tenantId}:${version}`;
  }

  /** The tenant's active data key, creating the first one on demand. */
  private async activeKey(tenantId: string): Promise<{ version: number; dek: Buffer }> {
    const known = this.active.get(tenantId);
    if (known && known.until > Date.now()) {
      const dek = this.cache.get(this.cacheKey(tenantId, known.version));
      if (dek) return { version: known.version, dek };
    }
    let record = await this.store.getActive(tenantId);
    if (!record) {
      const name = await this.keys.ensureTenantKey(tenantId);
      const fresh = await this.keys.generateDataKey(tenantId);
      record = { version: 1, wrapped: fresh.wrapped };
      await this.store.insert(tenantId, { ...record, kekName: name });
      this.cache.set(this.cacheKey(tenantId, 1), fresh.plaintext);
      this.active.set(tenantId, { version: 1, until: Date.now() + this.activeTtlMs });
      return { version: 1, dek: fresh.plaintext };
    }
    const dek = await this.dekFor(tenantId, record);
    this.active.set(tenantId, { version: record.version, until: Date.now() + this.activeTtlMs });
    return { version: record.version, dek };
  }

  private async dekFor(tenantId: string, record: TenantKeyRecord): Promise<Buffer> {
    const k = this.cacheKey(tenantId, record.version);
    let dek = this.cache.get(k);
    if (!dek) {
      dek = await this.keys.unwrapDataKey(tenantId, record.wrapped);
      this.cache.set(k, dek);
    }
    return dek;
  }

  async encrypt(tenantId: string, plaintext: string): Promise<Buffer> {
    const { version, dek } = await this.activeKey(tenantId);
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv('aes-256-gcm', dek, iv, { authTagLength: TAG_BYTES });
    cipher.setAAD(Buffer.from(tenantId));
    const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const header = Buffer.alloc(3);
    header[0] = VERSION_BYTE;
    header.writeUInt16BE(version, 1);
    return Buffer.concat([header, iv, cipher.getAuthTag(), ct]);
  }

  async decrypt(tenantId: string, blob: Buffer): Promise<string> {
    if (blob.length < 3 + IV_BYTES + TAG_BYTES || blob[0] !== VERSION_BYTE) {
      throw new Error('unrecognised ciphertext');
    }
    const version = blob.readUInt16BE(1);
    // A version's data key never changes, so a known one needs no lookup.
    let dek = this.cache.get(this.cacheKey(tenantId, version));
    if (!dek) {
      const record = await this.store.get(tenantId, version);
      if (!record) throw new Error('data key version not found');
      dek = await this.dekFor(tenantId, record);
    }
    const iv = blob.subarray(3, 3 + IV_BYTES);
    const tag = blob.subarray(3 + IV_BYTES, 3 + IV_BYTES + TAG_BYTES);
    const ct = blob.subarray(3 + IV_BYTES + TAG_BYTES);
    const decipher = createDecipheriv('aes-256-gcm', dek, iv, { authTagLength: TAG_BYTES });
    decipher.setAAD(Buffer.from(tenantId));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
  }

  /** Deterministic per tenant and purpose; useless without the data key. */
  async blindIndex(tenantId: string, purpose: string, value: string): Promise<Buffer> {
    const { dek } = await this.activeKey(tenantId);
    const key = Buffer.from(hkdfSync('sha256', dek, Buffer.from(tenantId), `bidx:${purpose}`, 32));
    return createHmac('sha256', key).update(value).digest();
  }
}

/** Phone numbers normalised to digits with a leading + for E.164 inputs (FL-02 lookups). */
export function normalisePhone(raw: string): string {
  const digits = raw.replace(/[^\d+]/g, '');
  if (digits.startsWith('+')) return `+${digits.slice(1).replace(/\+/g, '')}`;
  return digits.length === 10 ? `+1${digits}` : `+${digits}`;
}

export { kekName };
