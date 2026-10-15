/**
 * The joint damage assessment from the database (FL:FR-10, DCL:DEC-13,
 * Form 010-0-13 Box 10): the schedule, the sample route in force and the
 * latest mark on each stop. A stop shows what the street sheet shows of its
 * home (record reference, degree, type, units, 100 m cell and its centre,
 * ZIP, tract, jurisdiction) and nothing personal: no name, contact or
 * address. The candidates for a new sample are the verified, counted homes.
 */
import { sql, type Transaction } from 'kysely';
import type { Database } from '@cg/db';
import { DEGREES, classifyHomes, statusOf, type Degree } from '../counting.ts';
import { loadDamageRecords } from '../load.ts';
import { homeRows, type HomeRow } from './data.ts';
import { jointPdaBox10, type SampleCandidate } from './joint.ts';

type Trx = Transaction<Database>;

export interface JointMark {
  result: 'validated' | 'different' | 'not_seen';
  degreeSeen: Degree | 'no_damage' | null;
  note: string | null;
  markedBy: string | null;
  markedAt: string;
}

export interface JointStop {
  id: string;
  seq: number;
  stratum: Degree;
  home: {
    ref: string | null;
    degree: string | null;
    type: string | null;
    units: number | null;
    usng: string | null;
    postal: string | null;
    tract: string | null;
    jurisdiction: string | null;
    /** [lon, lat] of the 100 m cell centre. */
    point: [number, number] | null;
    /** Still counted as the record that stands for a verified home. */
    counted: boolean;
  } | null;
  mark: JointMark | null;
}

export interface JointSchedule {
  id: string | null;
  version: number | null;
  startsOn: string | null;
  endsOn: string | null;
  areas: string[];
  teams: { name: string; members: string }[];
  status: 'planned' | 'in_progress' | 'done';
  sampleVersion: number;
  sampleSize: number | null;
  sampleSeed: number | null;
  sampledAt: string | null;
}

export interface JointSummary {
  stops: number;
  validated: number;
  different: number;
  notSeen: number;
  pending: number;
}

const str = (v: unknown) => (typeof v === 'string' ? v : null);

export async function jointSchedule(trx: Trx, eventId: string): Promise<JointSchedule> {
  const r = await sql<{
    id: string;
    version: number;
    starts_on: string | null;
    ends_on: string | null;
    areas: string[];
    teams: { name: string; members: string }[];
    status: JointSchedule['status'];
    sample_version: number;
    sample_size: number | null;
    sample_seed: number | null;
    sampled_at: Date | null;
  }>`
    select id, version, to_char(starts_on, 'YYYY-MM-DD') as starts_on,
      to_char(ends_on, 'YYYY-MM-DD') as ends_on, areas, teams, status, sample_version,
      sample_size, sample_seed, sampled_at
    from cg.joint_pda where event_id = ${eventId}::uuid`.execute(trx);
  const j = r.rows[0];
  if (!j)
    return {
      id: null,
      version: null,
      startsOn: null,
      endsOn: null,
      areas: [],
      teams: [],
      status: 'planned',
      sampleVersion: 0,
      sampleSize: null,
      sampleSeed: null,
      sampledAt: null,
    };
  return {
    id: j.id,
    version: j.version,
    startsOn: j.starts_on,
    endsOn: j.ends_on,
    areas: j.areas,
    teams: j.teams,
    status: j.status,
    sampleVersion: j.sample_version,
    sampleSize: j.sample_size,
    sampleSeed: j.sample_seed,
    sampledAt: j.sampled_at ? j.sampled_at.toISOString() : null,
  };
}

/** Box 10 of Form 010-0-13 for the package. */
export async function jointBox10(trx: Trx, eventId: string) {
  const j = await jointSchedule(trx, eventId);
  return jointPdaBox10(j.id ? j : null);
}

const timeZoneOf = async (trx: Trx, eventId: string) =>
  (
    await trx
      .selectFrom('cg.event as e')
      .innerJoin('cg.tenant as t', 't.id', 'e.tenant_id')
      .select('t.timezone')
      .where('e.id', '=', eventId)
      .executeTakeFirst()
  )?.timezone ?? 'America/Chicago';

/** The verified, counted homes a sample is drawn from. */
export async function jointCandidates(
  trx: Trx,
  tenantId: string,
  eventId: string,
): Promise<SampleCandidate[]> {
  const homes = classifyHomes(await loadDamageRecords(trx, eventId)).homes.filter(
    (h) => h.status === 'counted' && (DEGREES as readonly string[]).includes(h.record.degree ?? ''),
  );
  const rows = await homeRows(trx, tenantId, homes, await timeZoneOf(trx, eventId));
  return rows.map((r, i) => ({
    recordId: r.recordId,
    kind: homes[i]!.record.kind === 'assessment' ? ('assessment' as const) : ('report' as const),
    degree: homes[i]!.record.degree as Degree,
    point: r.point,
  }));
}

/** The sample route in force with each stop's home, generalized, and its latest mark. */
export async function jointStops(
  trx: Trx,
  tenantId: string,
  eventId: string,
  schedule: JointSchedule,
): Promise<JointStop[]> {
  if (!schedule.id || schedule.sampleVersion === 0) return [];
  const stops = await trx
    .selectFrom('cg.joint_pda_stop')
    .select(['id', 'seq', 'stratum', 'record_id'])
    .where('joint_pda_id', '=', schedule.id)
    .where('sample_version', '=', schedule.sampleVersion)
    .orderBy('seq')
    .execute();
  if (!stops.length) return [];
  const records = await loadDamageRecords(trx, eventId);
  const byId = new Map(records.map((r) => [r.id, r]));
  const counted = new Set(
    classifyHomes(records)
      .homes.filter((h) => h.status === 'counted')
      .map((h) => h.record.id),
  );
  const found = stops.map((s) => byId.get(s.record_id)).filter((r) => r !== undefined);
  const rows = await homeRows(
    trx,
    tenantId,
    found.map((record) => ({ record, status: statusOf(record) })),
    await timeZoneOf(trx, eventId),
  );
  const rowOf = new Map<string, HomeRow>(rows.map((r) => [r.recordId, r]));
  const marks = await sql<{
    stop_id: string;
    result: JointMark['result'];
    degree_seen: JointMark['degreeSeen'];
    note: string | null;
    marked_by: string | null;
    marked_at: Date;
  }>`
    select distinct on (m.stop_id) m.stop_id, m.result, m.degree_seen, m.note,
      a.display_name as marked_by, m.marked_at
    from cg.joint_pda_mark m
    left join cg.account a on a.id = m.marked_by
    where m.stop_id = any(${stops.map((s) => s.id)}::uuid[])
    order by m.stop_id, m.marked_at desc, m.id desc`.execute(trx);
  const markOf = new Map(marks.rows.map((m) => [m.stop_id, m]));
  return stops.map((s) => {
    const row = rowOf.get(s.record_id);
    const m = markOf.get(s.id);
    const v = row?.values ?? {};
    return {
      id: s.id,
      seq: s.seq,
      stratum: s.stratum,
      home: row
        ? {
            ref: str(v['record.ref']),
            degree: str(v['home.degree']),
            type: str(v['home.type']),
            units: typeof v['home.units'] === 'number' ? v['home.units'] : null,
            usng: str(v['location.usng']),
            postal: str(v['location.postal']),
            tract: str(v['location.tract']),
            jurisdiction: str(v['location.jurisdiction']),
            point: row.point,
            counted: counted.has(s.record_id),
          }
        : null,
      mark: m
        ? {
            result: m.result,
            degreeSeen: m.degree_seen,
            note: m.note,
            markedBy: m.marked_by,
            markedAt: m.marked_at.toISOString(),
          }
        : null,
    };
  });
}

export function jointSummary(stops: readonly JointStop[]): JointSummary {
  const n = (r: JointMark['result']) => stops.filter((s) => s.mark?.result === r).length;
  return {
    stops: stops.length,
    validated: n('validated'),
    different: n('different'),
    notSeen: n('not_seen'),
    pending: stops.filter((s) => !s.mark).length,
  };
}
