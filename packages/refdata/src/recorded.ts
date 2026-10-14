/**
 * Recorded responses (ADR-0039, SCL-12): development and CI never call the
 * federal services. A recording directory holds `index.json` and one file
 * per response, in the source's real format but filled with synthetic values
 * for the fictional WESTWIND county. A request matches an entry by host, path
 * and the query parameters the entry names, exactly or by a part of their
 * value (other parameters are ignored, so a key does not break the match). A request with no
 * recording fails loudly instead of reaching the network.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { EgressHttp } from './http.ts';

export interface Recording {
  host: string;
  path: string;
  /** Parameters that must equal these values. */
  query?: Record<string, string>;
  /** Parameters that must contain these texts (a filter that also names today's date). */
  contains?: Record<string, string>;
  file: string;
}

export class NoRecording extends Error {
  constructor(url: string) {
    super(`no recorded response for ${url}`);
    this.name = 'NoRecording';
  }
}

export function matchRecording(recordings: readonly Recording[], url: string): Recording | null {
  const u = new URL(url);
  return (
    recordings.find(
      (r) =>
        r.host === u.hostname &&
        r.path === u.pathname &&
        Object.entries(r.query ?? {}).every(([k, v]) => u.searchParams.get(k) === v) &&
        Object.entries(r.contains ?? {}).every(([k, v]) =>
          (u.searchParams.get(k) ?? '').includes(v),
        ),
    ) ?? null
  );
}

export function createRecordedHttp(dir: string): EgressHttp {
  const recordings = JSON.parse(readFileSync(join(dir, 'index.json'), 'utf8')) as Recording[];
  const body = (url: string): string => {
    const hit = matchRecording(recordings, url);
    if (!hit) throw new NoRecording(new URL(url).origin + new URL(url).pathname);
    return readFileSync(join(dir, hit.file), 'utf8');
  };
  return {
    getJson: async (url) => JSON.parse(body(url)) as unknown,
    getText: async (url) => body(url),
  };
}
