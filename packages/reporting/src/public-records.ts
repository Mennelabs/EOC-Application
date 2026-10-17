/**
 * Public-records release (SEC-13: "public-records request export that redacts
 * restricted fields"). A records officer answers a request with the records
 * of one event, optionally a date range, and the kinds of record asked for.
 * What leaves is decided column by column from the data dictionary (SEC-11)
 * and a few rules on top, always toward withholding (plan reading: the
 * requirement names restricted fields; the reading that best protects
 * residents withholds sensitive ones too):
 *
 * - restricted, sensitive and criminal-justice columns are withheld;
 * - security values (hashes, encrypted values, codes, execution ids, the
 *   reference codes residents look their own records up with) are withheld;
 * - links to a person or a place (party ids, location ids, positions,
 *   geometry, routes) and free-form detail are withheld;
 * - needs a household told us about (need signals, danger flags) are withheld;
 * - confidential sites (a domestic-violence shelter, for one) are left out
 *   entirely, and only issued official reports go.
 *
 * Every withheld column is listed with its reason in REDACTIONS.csv. A person
 * reviews the file before it is released: the platform prepares the release,
 * it does not decide what the law exempts.
 */
import { dictionary, type Classification } from '@cg/db';
import { toCsv, type CsvValue } from './csv.ts';
import { zip } from './zip.ts';

export const RECORD_TYPES = {
  reports: {
    read: 'report.read',
    table: 'report',
    label: 'Resident reports',
    from: 'cg.report x',
    event: 'x.event_id',
    date: 'x.created_at',
    where: null,
  },
  needs: {
    read: 'need.read',
    table: 'need',
    label: 'Needs',
    from: 'cg.need x',
    event: 'x.event_id',
    date: 'x.created_at',
    where: null,
  },
  missions: {
    read: 'mission.read',
    table: 'mission',
    label: 'Missions',
    from: 'cg.mission x',
    event: 'x.event_id',
    date: 'x.created_at',
    where: null,
  },
  mission_timeline: {
    read: 'mission.read',
    table: 'mission_event',
    label: 'Mission timeline entries',
    from: 'cg.mission_event x join cg.mission m on m.id = x.mission_id',
    event: 'm.event_id',
    date: 'x.occurred_at',
    where: null,
  },
  sites: {
    read: 'site.read',
    table: 'site',
    label: 'Sites (confidential sites are left out)',
    from: 'cg.site x',
    event: 'x.event_id',
    date: 'x.created_at',
    where: 'x.confidential is not true',
  },
  official_reports: {
    read: 'official_report.read',
    table: 'official_report',
    label: 'Issued official reports',
    from: 'cg.official_report x',
    event: 'x.event_id',
    date: 'x.created_at',
    where: "x.state in ('issued', 'superseded')",
  },
  field_messages: {
    read: 'field_message.read',
    table: 'field_message',
    label: 'Messages to field staff',
    from: 'cg.field_message x',
    event: 'x.event_id',
    date: 'x.sent_at',
    where: null,
  },
  comms_log: {
    read: 'comms_log.read',
    table: 'comms_log',
    label: 'Radio and communications log',
    from: 'cg.comms_log x',
    event: 'x.event_id',
    date: 'x.entry_at',
    where: null,
  },
} as const;

export type RecordType = keyof typeof RECORD_TYPES;
export const RECORD_TYPE_KEYS = Object.keys(RECORD_TYPES) as RecordType[];

export type WithheldReason =
  | 'restricted'
  | 'sensitive'
  | 'criminal justice'
  | 'security value'
  | 'links to a person or place'
  | 'free-form detail'
  | 'household needs';

const SECURITY = /(_hash|_enc|_bidx)$|^(execution_id|client_uuid|check_in_code|content_hash)$/;
const PERSON_OR_PLACE =
  /(_party_id|_geom|_position_id)$|^(location_id|geom|position_id|route|accuracy_m)$/;
const CJI = /cji|^case_reference$/;
const DETAIL = /^(detail|details)$/;
const HOUSEHOLD: Record<string, string[]> = {
  report: ['need_signals', 'flags', 'danger_flag', 'told_to_call_911_at'],
};
/** Codes residents use to find their own report or need (DEC-13 keeps them out of packages too). */
const RESIDENT_CODES: Record<string, string[]> = {
  report: ['reference_code'],
  need: ['reference_code'],
};

/** Whether one column of one table leaves in a public-records release, and why not. */
export function releaseRule(
  table: string,
  column: string,
): { release: true } | { release: false; why: WithheldReason } {
  const entry = dictionary[table]?.[column];
  const c: Classification = entry?.c ?? 'restricted';
  if (c === 'cji' || CJI.test(column)) return { release: false, why: 'criminal justice' };
  if (c === 'restricted') return { release: false, why: 'restricted' };
  if (c === 'sensitive') return { release: false, why: 'sensitive' };
  if (SECURITY.test(column) || RESIDENT_CODES[table]?.includes(column))
    return { release: false, why: 'security value' };
  if (PERSON_OR_PLACE.test(column)) return { release: false, why: 'links to a person or place' };
  if (DETAIL.test(column)) return { release: false, why: 'free-form detail' };
  if (HOUSEHOLD[table]?.includes(column)) return { release: false, why: 'household needs' };
  return { release: true };
}

/** The released and withheld columns of a record type, in dictionary order. */
export function releasePlan(type: RecordType): {
  released: string[];
  withheld: { column: string; why: WithheldReason }[];
} {
  const table = RECORD_TYPES[type].table;
  const released: string[] = [];
  const withheld: { column: string; why: WithheldReason }[] = [];
  for (const column of Object.keys(dictionary[table] ?? {})) {
    const r = releaseRule(table, column);
    if (r.release) released.push(column);
    else withheld.push({ column, why: r.why });
  }
  return { released, withheld };
}

export interface PublicRecordsScope {
  requestReference: string;
  recordTypes: RecordType[];
  from: string | null;
  to: string | null;
}

export interface PublicRecordsData {
  event: { name: string };
  rows: Partial<Record<RecordType, Record<string, unknown>[]>>;
}

const cell = (v: unknown): CsvValue => {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v.toISOString();
  if (Array.isArray(v)) return v.map((x) => String(x)).join('; ');
  if (typeof v === 'object') return JSON.stringify(v);
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return v;
  return String(v);
};

/** The release as a ZIP: one CSV per kind of record, REDACTIONS.csv and a README. */
export function buildPublicRecords(
  data: PublicRecordsData,
  scope: PublicRecordsScope,
  meta: { productName: string; generatedAt: Date },
): { body: Buffer; counts: Record<string, number>; withheldColumns: number } {
  const entries: { name: string; body: string }[] = [];
  const counts: Record<string, number> = {};
  const redactions: CsvValue[][] = [];
  for (const type of scope.recordTypes) {
    const plan = releasePlan(type);
    const rows = data.rows[type] ?? [];
    counts[type] = rows.length;
    entries.push({
      name: `${type}.csv`,
      body: toCsv(
        plan.released,
        rows.map((r) => plan.released.map((c) => cell(r[c]))),
      ),
    });
    for (const w of plan.withheld) redactions.push([type, w.column, w.why]);
  }
  entries.push({
    name: 'REDACTIONS.csv',
    body: toCsv(['record_type', 'column', 'withheld_because'], redactions),
  });
  const period =
    scope.from || scope.to
      ? `${scope.from ?? 'the start'} to ${scope.to ?? 'the end'}`
      : 'the whole event';
  const readme = [
    `Public-records release prepared by ${meta.productName}`,
    '',
    `Request: ${scope.requestReference}`,
    `Event: ${data.event.name}`,
    `Period: ${period}`,
    `Prepared: ${meta.generatedAt.toISOString()}`,
    '',
    'Records:',
    ...scope.recordTypes.map((t) => `- ${t}.csv: ${RECORD_TYPES[t].label}, ${counts[t]} rows`),
    '',
    'What was withheld, column by column, is in REDACTIONS.csv:',
    '- restricted and sensitive details (names, contact details, addresses, what residents wrote or said, notes and reasons);',
    '- criminal-justice information, which never leaves its enclave;',
    '- security values (codes, hashes, encrypted values, request ids);',
    '- links to a person or a place (people, addresses, positions, routes) and free-form detail;',
    '- needs a household told us about (for example medical or safety needs).',
    'Confidential sites are left out entirely; only issued official reports are included.',
    '',
    'A person must review this file before it is released. It is prepared from the',
    'records as they stand; it does not decide what the law exempts.',
    '',
  ].join('\r\n');
  entries.unshift({ name: 'README.txt', body: readme });
  return {
    body: zip(entries, meta.generatedAt),
    counts,
    withheldColumns: redactions.length,
  };
}
