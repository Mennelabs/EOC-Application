/**
 * Live conditions (CON-14): the parsers, one per feed kind, and the pull
 * that reads a feed through the allow-listed HTTP client (recorded
 * synthetic responses in development and CI, ADR-0039).
 */
import type { EgressHttp } from '../http.ts';
import { parseOutages } from './outage.ts';
import type { LiveSourceKind, ParseResult } from './types.ts';
import { parseWaze } from './waze.ts';
import { parseWzdx } from './wzdx.ts';

export * from './types.ts';
export { parseWzdx } from './wzdx.ts';
export { parseWaze } from './waze.ts';
export { parseOutages } from './outage.ts';
export * from './apply.ts';

export const LIVE_PARSERS: Record<LiveSourceKind, (doc: unknown, now: Date) => ParseResult> = {
  wzdx: parseWzdx,
  waze: parseWaze,
  utility: parseOutages,
};

/** A feed's items, read from its address: the document is parsed, never stored as such. */
export async function pullLiveFeed(
  http: EgressHttp,
  kind: LiveSourceKind,
  url: string,
  now: Date,
): Promise<ParseResult> {
  const doc = await http.getJson(url);
  return LIVE_PARSERS[kind](doc, now);
}
