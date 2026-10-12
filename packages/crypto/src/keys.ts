/**
 * Key service adapter (ADR-0009): wraps and unwraps per-tenant data keys.
 * Locally OpenBao's transit engine; in the government cloud the provider's
 * KMS implements the same three calls. Plaintext data keys live only in
 * process memory.
 */
import { randomBytes } from 'node:crypto';

export interface KeyService {
  /** Create the tenant's key-encryption key if it does not exist (idempotent). */
  ensureTenantKey(tenantId: string): Promise<string>;
  /** A fresh 256-bit data key: plaintext for use now, wrapped form for storage. */
  generateDataKey(tenantId: string): Promise<{ plaintext: Buffer; wrapped: string }>;
  unwrapDataKey(tenantId: string, wrapped: string): Promise<Buffer>;
}

export const kekName = (tenantId: string): string => `tenant-${tenantId}`;

export class OpenBaoKeyService implements KeyService {
  private readonly addr: string;
  private readonly token: string;

  constructor(addr: string, token: string) {
    this.addr = addr.replace(/\/$/, '');
    this.token = token;
  }

  private async call<T>(path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.addr}/v1/${path}`, {
      method: 'POST',
      headers: { 'X-Vault-Token': this.token, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (res.status === 204) return undefined as T;
    if (!res.ok)
      throw new Error(
        `key service ${path.split('/')[0]}/${path.split('/')[1]} failed: HTTP ${res.status}`,
      );
    return (await res.json()) as T;
  }

  async ensureTenantKey(tenantId: string): Promise<string> {
    const name = kekName(tenantId);
    // Creating an existing key is a no-op in transit.
    await this.call(`transit/keys/${name}`, { type: 'aes256-gcm96', exportable: false });
    return name;
  }

  async generateDataKey(tenantId: string): Promise<{ plaintext: Buffer; wrapped: string }> {
    const r = await this.call<{ data: { plaintext: string; ciphertext: string } }>(
      `transit/datakey/plaintext/${kekName(tenantId)}`,
      { bits: 256 },
    );
    return { plaintext: Buffer.from(r.data.plaintext, 'base64'), wrapped: r.data.ciphertext };
  }

  async unwrapDataKey(tenantId: string, wrapped: string): Promise<Buffer> {
    const r = await this.call<{ data: { plaintext: string } }>(
      `transit/decrypt/${kekName(tenantId)}`,
      { ciphertext: wrapped },
    );
    return Buffer.from(r.data.plaintext, 'base64');
  }
}

/** Tests only: "wraps" by XOR with a per-tenant random pad. Never for real data. */
export class InMemoryKeyService implements KeyService {
  private readonly pads = new Map<string, Buffer>();

  private pad(tenantId: string): Buffer {
    let p = this.pads.get(tenantId);
    if (!p) {
      p = randomBytes(32);
      this.pads.set(tenantId, p);
    }
    return p;
  }

  async ensureTenantKey(tenantId: string): Promise<string> {
    this.pad(tenantId);
    return kekName(tenantId);
  }

  async generateDataKey(tenantId: string): Promise<{ plaintext: Buffer; wrapped: string }> {
    const plaintext = randomBytes(32);
    const pad = this.pad(tenantId);
    const wrapped = Buffer.from(plaintext.map((b, i) => b ^ (pad[i] ?? 0))).toString('base64');
    return { plaintext, wrapped: `mem:${wrapped}` };
  }

  async unwrapDataKey(tenantId: string, wrapped: string): Promise<Buffer> {
    if (!wrapped.startsWith('mem:')) throw new Error('not an in-memory wrapped key');
    const pad = this.pad(tenantId);
    const bytes = Buffer.from(wrapped.slice(4), 'base64');
    return Buffer.from(bytes.map((b, i) => b ^ (pad[i] ?? 0)));
  }
}
