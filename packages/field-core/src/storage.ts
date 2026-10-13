/**
 * Storage behind an adapter (plan §5, ADR-0032; NFR-08): the phone keeps
 * records in SQLCipher, the web build in IndexedDB under an AES-GCM key; the
 * core only needs collections of JSON documents with a few indexes. The
 * memory store is the test double and the first implementation the web
 * build wraps.
 */

export interface StoredDoc {
  id: string;
  [key: string]: unknown;
}

export interface FieldStore {
  get<T extends object = StoredDoc>(collection: string, id: string): Promise<T | null>;
  put<T extends StoredDoc>(collection: string, doc: T): Promise<void>;
  delete(collection: string, id: string): Promise<void>;
  list<T extends object = StoredDoc>(
    collection: string,
    filter?: (doc: T) => boolean,
  ): Promise<T[]>;
  clear(collection: string): Promise<void>;
  collections(): Promise<string[]>;
  /** Small key–value state (cursor, device id, settings) beside the collections. */
  getMeta(key: string): Promise<string | null>;
  setMeta(key: string, value: string | null): Promise<void>;
}

export class MemoryStore implements FieldStore {
  private readonly data = new Map<string, Map<string, StoredDoc>>();
  private readonly meta = new Map<string, string>();

  private coll(name: string): Map<string, StoredDoc> {
    let c = this.data.get(name);
    if (!c) {
      c = new Map();
      this.data.set(name, c);
    }
    return c;
  }
  async get<T extends object = StoredDoc>(collection: string, id: string): Promise<T | null> {
    const d = this.coll(collection).get(id);
    return d ? (structuredClone(d) as T) : null;
  }
  async put<T extends StoredDoc>(collection: string, doc: T): Promise<void> {
    this.coll(collection).set(doc.id, structuredClone(doc));
  }
  async delete(collection: string, id: string): Promise<void> {
    this.coll(collection).delete(id);
  }
  async list<T extends object = StoredDoc>(
    collection: string,
    filter?: (doc: T) => boolean,
  ): Promise<T[]> {
    const all = [...this.coll(collection).values()].map((d) => structuredClone(d) as T);
    return filter ? all.filter(filter) : all;
  }
  async clear(collection: string): Promise<void> {
    this.data.delete(collection);
  }
  async collections(): Promise<string[]> {
    return [...this.data.keys()];
  }
  async getMeta(key: string): Promise<string | null> {
    return this.meta.get(key) ?? null;
  }
  async setMeta(key: string, value: string | null): Promise<void> {
    if (value === null) this.meta.delete(key);
    else this.meta.set(key, value);
  }
}
