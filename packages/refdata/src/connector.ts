/**
 * A reference connector (ADR-0039): one free source, one dataset. It asks
 * only for geography (state and county FIPS codes, or a bounding box) and
 * yields rows in the source's terms; the snapshot writer checks every row
 * against the dataset's schema before anything is stored.
 */
import type { Dataset, RawRow } from './datasets.ts';
import type { EgressHttp } from './http.ts';

export interface Scope {
  /** Two-digit state FIPS code. */
  stateFips: string;
  /** Five-digit county FIPS codes covered by the tenant. */
  countyFips: string[];
  /** [west, south, east, north] in WGS84, when the source answers by area (from the tract outline). */
  bbox?: [number, number, number, number];
  /** County names as sources that filter by name use them ("WESTWIND"), one per county code. */
  countyNames?: string[];
}

export interface ConnectorContext {
  http: EgressHttp;
  scope: Scope;
  /** Free keys some sources ask for; secrets, never logged or stored in a snapshot. */
  secrets: { censusApiKey?: string };
  now: () => Date;
}

export interface FetchResult {
  /** The edition of the data, as the source names it (e.g. "ACS 2020-2024 5-year"). */
  vintage: string | null;
  /** Where the data came from, with any key redacted. */
  sourceUrl: string;
  rows: AsyncIterable<RawRow> | Iterable<RawRow>;
}

export interface Connector {
  id: string;
  dataset: Dataset;
  /** What a person reads in the console. */
  title: string;
  licence: string;
  /** Hosts this connector may reach; the configured allowlist must also hold them. */
  hosts: readonly string[];
  /** How often the worker refreshes it by default. */
  refreshMs: number;
  /** Geography beyond the FIPS codes the request needs; the schedule waits until the tenant has it. */
  requires?: readonly ('bbox' | 'countyNames')[];
  fetch(ctx: ConnectorContext): Promise<FetchResult>;
}
