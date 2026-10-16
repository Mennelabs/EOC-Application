/**
 * The command catalog (layer-7 task B; ADR-0044; CMD-12, BRD:FR-C03, CMD-13,
 * CMD-16, CMD-22, CMD-28, Section 30.2). Only what is listed here can run from
 * the command window; anything else is answered as unsupported, never as done.
 *
 * Each command declares the authorization action its operation checks, its
 * rollout phase (Section 30.2: 1 lookups and drafts, 2 reversible updates, 3
 * assignments and status, 4 approvals and the rest), its argument schema, the
 * kind of record it targets, its confirmation class, its reversal policy, the
 * console operation it calls (method, path, body, expected version), how to
 * undo it when it can be undone, and how to word the plan and the verified
 * result from the operation's own response (CMD-26).
 */
import { z } from 'zod';
import { RECORD_TYPES, RECORD_TYPE_KEYS, type RecordType } from '@cg/reporting';

export type Confirmation = 'none' | 'one_tap' | 'full_review' | 'second_person';
export type Reversal = 'undo_15_min' | 'compensating' | 'none';
export type TargetKind =
  | 'mission'
  | 'need'
  | 'reminder'
  | 'check_in'
  | 'official_report'
  | 'report'
  | 'team'
  | 'personnel'
  | 'resource';

/** A resolved record the command acts on, with the version it had when the plan was made. */
export interface Target {
  kind: TargetKind;
  id: string;
  version: number;
  label: string;
  /** What the fields a command changes held when the plan was made, so undo can put them back. */
  was?: Record<string, string> | undefined;
}

export interface OpRequest {
  method: 'GET' | 'POST' | 'PATCH';
  /** Under /api/v1. */
  path: string;
  body?: Record<string, unknown>;
  /** Sent as If-Match: the version the plan was made against (CMD-09). */
  version?: number | undefined;
}

export interface OpContext {
  now: Date;
  /** The open event the request is about, when the command needs one. */
  eventId: string | null;
  executionId: string;
}

export interface Verified {
  /** CMD-26: found, drafted, saved or queued; never a claim the operation did not make. */
  state: 'found' | 'drafted' | 'saved' | 'queued';
  summary: string;
  records: { kind: string; id: string; label?: string | undefined; version?: number | undefined }[];
  /** CMD-30: the records of a batch the operation refused, each with its reason. */
  failures?: { id: string; label: string; code: string; message: string }[];
}

/** Section 30.2: one confirmation covers this many records; more needs the count typed. */
export const BATCH_ONE_CONFIRMATION = 50;
/** Section 30.2: more than this is a scheduled bulk job on its own screen, not a command. */
export const BATCH_MAX = 500;

/**
 * CMD-30: a command over the records a filter names. The engine lists them
 * through the console's own route as the person may see them, shows the count
 * and some of them in the plan, and runs one operation per record, each with
 * its own idempotency key; each record's result is reported.
 */
export interface BulkSpec<A> {
  /** The list route without limit or offset; the engine pages through it. */
  list(args: A, ctx: { tenantId: string }): string;
  /** The operation for one record. */
  item(args: A, record: Target): OpRequest;
  /** The plan's words for the batch, given how many and the first few labels. */
  describe(args: A, count: number, sample: string[]): string;
  /** The verified result's words. */
  done(count: number, of: number): string;
}

export interface CommandSpec<A = Record<string, unknown>> {
  name: string;
  version: number;
  phase: 1 | 2 | 3 | 4;
  action: string;
  kind: 'lookup' | 'draft' | 'change';
  title: string;
  usage: string;
  args: z.ZodType<A>;
  target?: TargetKind;
  /** Needs the open event (drafts that are about one). */
  needsEvent?: boolean;
  /**
   * The `person` argument names someone on the roster. The server resolves it
   * among the people the caller may see, asks which one when several match
   * (CMD-08), and puts the chosen id in `personId` before the plan is shown.
   */
  person?: boolean;
  /** CMD-30: runs over many records (phase 4, `command.bulk`); `target` names their kind. */
  bulk?: BulkSpec<A>;
  confirmation: Confirmation;
  reversal: Reversal;
  sideEffects: string;
  /**
   * Arguments that are free text a person typed. Once the command has run (or
   * was cancelled) the execution record keeps only their digest and length:
   * the text itself lives in the record it was saved to (CMD-37, NFR-10).
   */
  freeText?: string[];
  request(args: A, target: Target | null, ctx: OpContext): OpRequest;
  /** AC-C08: what "undo" answers when the change cannot be taken back, in this command's words. */
  undoUnavailable?: string;
  /** Undo from what the plan targeted and what the operation verified; never from free text. */
  undo?(args: A, target: Target | null, verified: Verified): OpRequest;
  describe(args: A, target: Target | null): string;
  verify(response: unknown): Verified;
}

const MISSION_STATES = ['open', 'en_route', 'on_scene', 'cleared'] as const;
const MISSION_KINDS = [
  'welfare_check',
  'verification_route',
  'cleanup_work_order',
  'delivery',
  'outreach_sweep',
  'site_staffing',
  'search',
  'road_clearance',
  'traffic_control',
  'debris',
  'other',
] as const;

/** CMD-14: what the window may set on a roster entry, and the field each one sets. */
const PERSON_SETTINGS = ['available', 'unavailable', 'on_duty', 'off_duty'] as const;
const PERSON_FIELD: Record<(typeof PERSON_SETTINGS)[number], 'availability' | 'dutyStatus'> = {
  available: 'availability',
  unavailable: 'availability',
  on_duty: 'dutyStatus',
  off_duty: 'dutyStatus',
};

const RESOURCE_TYPES = ['hotline', 'program', 'deadline', 'guidance', 'link', 'document'] as const;

type Row = Record<string, unknown>;
const rows = (r: unknown): Row[] => (Array.isArray(r) ? (r as Row[]) : []);
const str = (v: unknown) => (typeof v === 'string' ? v : '');
const ver = (v: unknown) => (typeof v === 'number' ? v : undefined);
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** CMD-17, CMD-26: the date the resource itself now holds. */
const resourceSaved = (r: unknown, what: string, field: string): Verified => {
  const d = (r ?? {}) as Row;
  const value = str(d[field]);
  return {
    state: 'saved',
    summary: `${str(d['slug'])}: ${value ? `${what} ${value}` : `no ${what}`}.`,
    records: [
      { kind: 'resource', id: str(d['id']), label: str(d['slug']), version: ver(d['version']) },
    ],
  };
};

/** CMD-15, CMD-26: the review state the operation itself returned. */
const reviewed = (r: unknown, what: string): Verified => {
  const d = (r ?? {}) as Row;
  return {
    state: 'saved',
    summary: `Report ${str(d['referenceCode'])} ${what}. Verification: ${str(d['verificationLevel']).replace(/_/g, ' ')}.`,
    records: [
      {
        kind: 'report',
        id: str(d['id']),
        label: str(d['referenceCode']),
        version: ver(d['version']),
      },
    ],
  };
};

/**
 * CMD-16, CMD-26: an export is queued, never "done"; the file is listed where it was asked for
 * (the declaration screen, the report, or the records requests) once the worker builds it.
 */
const queuedExport =
  (what: string, where: string, link: (d: Row) => { kind: string; id: string }) =>
  (r: unknown): Verified => {
    const d = (r ?? {}) as Row;
    return {
      state: 'queued',
      summary: `${what} is being prepared. It is listed on ${where} when it is ready; nothing is sent anywhere.`,
      records: [{ ...link(d), label: what }],
    };
  };

/** Each spec is checked against its own argument type, then kept in the catalog erased. */
const define = <A>(spec: CommandSpec<A>): CommandSpec => spec as unknown as CommandSpec;

export const CATALOG = [
  // ---------------------------------------------------------------- phase 1: lookups and drafts
  define({
    name: 'missions.find',
    version: 1,
    phase: 1,
    action: 'mission.read',
    kind: 'lookup',
    title: 'Find missions',
    usage: '/missions [open|unassigned|<state>]',
    args: z.object({
      open: z.boolean().optional(),
      unassigned: z.boolean().optional(),
      state: z
        .enum(['draft', 'open', 'en_route', 'on_scene', 'cleared', 'closed', 'canceled'])
        .optional(),
    }),
    confirmation: 'none',
    reversal: 'none',
    sideEffects: 'None: reads the missions you may see.',
    request: (a) => ({
      method: 'GET',
      path: `/missions?limit=20${a.open ? '&open=true' : ''}${a.unassigned ? '&unassigned=true' : ''}${a.state ? `&state=${a.state}` : ''}`,
    }),
    describe: (a) =>
      `Find ${a.unassigned ? 'unassigned ' : ''}${a.state ? `${a.state.replace('_', ' ')} ` : a.open ? 'open ' : ''}missions.`,
    verify: (r) => {
      const list = rows(r);
      return {
        state: 'found',
        summary: list.length
          ? `${plural(list.length, 'mission', 'missions')}: ${list
              .slice(0, 5)
              .map((m) => `${str(m['reference'])} (${str(m['state']).replace('_', ' ')})`)
              .join(', ')}${list.length > 5 ? ', …' : ''}.`
          : 'No mission matches.',
        records: list.map((m) => ({
          kind: 'mission',
          id: str(m['id']),
          label: str(m['reference']),
        })),
      };
    },
  }),
  define({
    name: 'mission.show',
    version: 1,
    phase: 1,
    action: 'mission.read',
    kind: 'lookup',
    title: 'Show a mission',
    usage: '/mission <reference>',
    args: z.object({}),
    target: 'mission',
    confirmation: 'none',
    reversal: 'none',
    sideEffects: 'None.',
    request: (_a, t) => ({ method: 'GET', path: `/missions/${t!.id}` }),
    describe: (_a, t) => `Show mission ${t!.label}.`,
    verify: (r) => {
      const m = (r ?? {}) as Row;
      return {
        state: 'found',
        summary: `Mission ${str(m['reference'])}: ${str(m['state']).replace('_', ' ')}, ${str(m['priority'])} priority${m['summary'] ? `. ${str(m['summary'])}` : ''}.`,
        records: [
          {
            kind: 'mission',
            id: str(m['id']),
            label: str(m['reference']),
            version: ver(m['version']),
          },
        ],
      };
    },
  }),
  define({
    name: 'needs.find',
    version: 1,
    phase: 1,
    action: 'need.read',
    kind: 'lookup',
    title: 'Find needs on the board',
    usage: '/needs [open|claimed|<reference code>]',
    args: z.object({
      status: z.enum(['open', 'claimed', 'in_progress', 'met', 'closed']).optional(),
      reference: z.string().min(6).max(12).optional(),
    }),
    confirmation: 'none',
    reversal: 'none',
    sideEffects: 'None: reads the board as you may see it.',
    request: (a) => ({
      method: 'GET',
      path: `/needs?limit=20${a.status ? `&status=${a.status}` : ''}${a.reference ? `&reference=${encodeURIComponent(a.reference)}` : ''}`,
    }),
    describe: (a) =>
      `Find ${a.status ? `${a.status.replace('_', ' ')} ` : ''}needs${a.reference ? ` for ${a.reference}` : ''}.`,
    verify: (r) => {
      const list = rows(r);
      return {
        state: 'found',
        summary: list.length
          ? `${plural(list.length, 'need', 'needs')}: ${list
              .slice(0, 5)
              .map(
                (n) =>
                  `${str(n['referenceCode']) || 'no reference'} ${str(n['category']).replace(/_/g, ' ')} (${str(n['status'])})`,
              )
              .join(', ')}${list.length > 5 ? ', …' : ''}.`
          : 'No need matches.',
        records: list.map((n) => ({
          kind: 'need',
          id: str(n['id']),
          label: str(n['referenceCode']),
        })),
      };
    },
  }),
  define({
    name: 'reminders.list',
    version: 1,
    phase: 1,
    action: 'reminder.read',
    kind: 'lookup',
    title: 'List reminders',
    usage: '/reminders',
    args: z.object({}),
    confirmation: 'none',
    reversal: 'none',
    sideEffects: 'None.',
    request: () => ({ method: 'GET', path: '/reminders?limit=20&open=true&mine=true' }),
    describe: () => 'List your reminders.',
    verify: (r) => {
      const list = rows(r).filter((x) => !['completed', 'canceled'].includes(str(x['state'])));
      return {
        state: 'found',
        summary: list.length
          ? `${plural(list.length, 'reminder', 'reminders')}: ${list
              .slice(0, 5)
              .map((x) => `${str(x['title'])}${x['overdue'] ? ' (overdue)' : ''}`)
              .join(', ')}.`
          : 'No open reminder.',
        records: list.map((x) => ({ kind: 'reminder', id: str(x['id']), label: str(x['title']) })),
      };
    },
  }),
  define({
    name: 'sitrep.draft',
    version: 1,
    phase: 1,
    action: 'official_report.draft',
    kind: 'draft',
    title: 'Draft a situation report',
    usage: '/sitrep [hours, e.g. 12]',
    args: z.object({ hours: z.number().int().min(1).max(168).default(12) }),
    needsEvent: true,
    confirmation: 'none',
    reversal: 'none',
    sideEffects:
      'Creates a draft from the records; nothing is issued. It needs review and a named issuer (RULE-10).',
    request: (a, _t, ctx) => ({
      method: 'POST',
      path: '/official-reports',
      body: {
        clientUuid: ctx.executionId,
        eventId: ctx.eventId,
        kind: 'sitrep',
        periodFrom: new Date(ctx.now.getTime() - a.hours * 3_600_000).toISOString(),
        periodTo: ctx.now.toISOString(),
      },
    }),
    describe: (a) => `Draft a situation report for the last ${plural(a.hours, 'hour', 'hours')}.`,
    verify: (r) => {
      const d = (r ?? {}) as Row;
      return {
        state: 'drafted',
        summary: `${str(d['title'])} drafted from the records. It is not issued: it needs review and a named issuer.`,
        records: [
          {
            kind: 'official_report',
            id: str(d['id']),
            label: str(d['title']),
            version: ver(d['version']),
          },
        ],
      };
    },
  }),

  define({
    name: 'people.find',
    version: 1,
    phase: 1,
    action: 'personnel.read',
    kind: 'lookup',
    title: 'Find people by skill, department or availability',
    usage: '/people [available|assigned|on_duty] [skill:<skill>] [department:<name>] [<name>]',
    args: z.object({
      availability: z.enum(['available', 'assigned', 'unavailable']).optional(),
      onDuty: z.boolean().optional(),
      skill: z.string().min(1).max(60).optional(),
      department: z.string().min(1).max(80).optional(),
      name: z.string().min(1).max(80).optional(),
    }),
    confirmation: 'none',
    reversal: 'none',
    sideEffects: 'None: reads the roster as you may see it, without contact details.',
    request: (a) => {
      const q = new URLSearchParams({ limit: '20' });
      if (a.availability) q.set('availability', a.availability);
      if (a.onDuty) q.set('onDuty', 'true');
      if (a.skill) q.set('skill', a.skill);
      if (a.department) q.set('department', a.department);
      if (a.name) q.set('q', a.name);
      return { method: 'GET', path: `/personnel?${q.toString()}` };
    },
    describe: (a) =>
      `Find ${a.availability ? `${a.availability} ` : ''}${a.onDuty ? 'on-duty ' : ''}people${a.skill ? ` with the recorded skill "${a.skill}"` : ''}${a.department ? ` in ${a.department}` : ''}${a.name ? ` named like "${a.name}"` : ''}.`,
    // CMD-14: only what is recorded; nothing about qualifications is inferred.
    verify: (r) => {
      const list = rows(r);
      return {
        state: 'found',
        summary: list.length
          ? `${plural(list.length, 'person', 'people')}: ${list
              .slice(0, 6)
              .map((p) => {
                const skills = Array.isArray(p['skills']) ? (p['skills'] as string[]) : [];
                return `${str(p['name'])} (${[str(p['operationalRole']) || str(p['department']), str(p['availability']), skills.length ? `skills: ${skills.join(', ')}` : 'no skills recorded'].filter(Boolean).join('; ')})`;
              })
              .join(', ')}${list.length > 6 ? ', …' : ''}.`
          : 'Nobody on the roster matches.',
        records: list.map((p) => ({ kind: 'personnel', id: str(p['id']), label: str(p['name']) })),
      };
    },
  }),
  define({
    name: 'reports.find',
    version: 1,
    phase: 1,
    action: 'report.read',
    kind: 'lookup',
    title: 'Find damage reports',
    usage: '/reports [submitted|under_review|needs_information|flagged|danger|<reference code>]',
    args: z.object({
      state: z
        .enum([
          'submitted',
          'under_review',
          'needs_information',
          'approved',
          'rejected',
          'duplicate',
        ])
        .optional(),
      flagged: z.boolean().optional(),
      danger: z.boolean().optional(),
      reference: z.string().min(6).max(12).optional(),
    }),
    confirmation: 'none',
    reversal: 'none',
    sideEffects: 'None: reads the review queue as you may see it.',
    request: (a) => {
      const q = new URLSearchParams({ limit: '20' });
      if (a.state) q.set('state', a.state);
      if (a.flagged) q.set('flagged', 'true');
      if (a.danger) q.set('danger', 'true');
      if (a.reference) q.set('reference', a.reference);
      return { method: 'GET', path: `/reports?${q.toString()}` };
    },
    describe: (a) =>
      `Find ${a.state ? `${a.state.replace('_', ' ')} ` : ''}${a.flagged ? 'flagged ' : ''}${a.danger ? 'danger-flagged ' : ''}reports${a.reference ? ` for ${a.reference}` : ''}.`,
    // CMD-15: public observations stay apart from verified assessments, and possible
    // duplicates are named for a person to judge.
    verify: (r) => {
      const list = rows(r);
      return {
        state: 'found',
        summary: list.length
          ? `${plural(list.length, 'report', 'reports')}: ${list
              .slice(0, 5)
              .map((x) => {
                const flags = Array.isArray(x['flags']) ? (x['flags'] as Row[]) : [];
                const dup = flags.some((f) => /duplicate/.test(str(f['kind'])));
                return `${str(x['referenceCode'])} (${str(x['reviewState']).replace('_', ' ')}, ${str(x['verificationLevel']).replace(/_/g, ' ')}${x['femaDegree'] ? `, ${str(x['femaDegree'])}` : ''}${dup ? ', possible duplicate' : ''})`;
              })
              .join(', ')}${list.length > 5 ? ', …' : ''}.`
          : 'No report matches.',
        records: list.map((x) => ({
          kind: 'report',
          id: str(x['id']),
          label: str(x['referenceCode']),
        })),
      };
    },
  }),
  define({
    name: 'resources.find',
    version: 1,
    phase: 1,
    action: 'resource.read',
    kind: 'lookup',
    title: 'Find published resources',
    usage: '/resources [<category>]',
    args: z.object({ category: z.string().min(1).max(60).optional() }),
    confirmation: 'none',
    reversal: 'none',
    sideEffects: 'None: reads the published resources.',
    request: (a) => ({
      method: 'GET',
      path: `/resources?limit=20&status=published${a.category ? `&category=${encodeURIComponent(a.category)}` : ''}`,
    }),
    describe: (a) => `Find published resources${a.category ? ` in ${a.category}` : ''}.`,
    verify: (r) => {
      const list = rows(r);
      const title = (x: Row) => {
        const texts = Array.isArray(x['texts']) ? (x['texts'] as Row[]) : [];
        const en = texts.find((t) => t['locale'] === 'en') ?? texts[0];
        return str(en?.['title']) || str(x['slug']);
      };
      return {
        state: 'found',
        summary: list.length
          ? `${plural(list.length, 'resource', 'resources')}: ${list
              .slice(0, 6)
              .map((x) => `${title(x)} (${str(x['category'])})`)
              .join(', ')}${list.length > 6 ? ', …' : ''}.`
          : 'No published resource matches.',
        records: list.map((x) => ({ kind: 'resource', id: str(x['id']), label: title(x) })),
      };
    },
  }),
  define({
    name: 'contacts.find',
    version: 1,
    phase: 1,
    action: 'contact.read',
    kind: 'lookup',
    title: 'Find partner contacts',
    usage: '/contacts [operations|24h|backup|media|liaison] [<agency>]',
    args: z.object({
      type: z.enum(['operations', 'twenty_four_hour', 'backup', 'media', 'liaison']).optional(),
      agency: z.string().min(1).max(120).optional(),
    }),
    confirmation: 'none',
    reversal: 'none',
    sideEffects:
      'None: reads the active contacts you may see; reading contact details is recorded (SEC-18).',
    request: (a) => ({
      method: 'GET',
      path: `/contacts?limit=50&active=true${a.type ? `&type=${a.type}` : ''}${a.agency ? `&agency=${encodeURIComponent(a.agency)}` : ''}`,
    }),
    describe: (a) =>
      `Find active ${a.type ? `${a.type.replace(/_/g, ' ')} ` : ''}contacts${a.agency ? ` for ${a.agency}` : ''}.`,
    verify: (r) => {
      const list = rows(r);
      return {
        state: 'found',
        summary: list.length
          ? `${plural(list.length, 'contact', 'contacts')}: ${list
              .slice(0, 6)
              .map(
                (c) =>
                  `${str(c['agency'])} ${str(c['type']).replace(/_/g, ' ')}${c['name'] ? `: ${str(c['name'])}` : ''}${c['due'] ? ' (re-check due)' : ''}`,
              )
              .join(', ')}${list.length > 6 ? ', …' : ''}.`
          : 'No active contact matches.',
        records: list.map((c) => ({ kind: 'contact', id: str(c['id']), label: str(c['agency']) })),
      };
    },
  }),

  // ---------------------------------------------------------------- phase 2: reversible updates
  define({
    name: 'need.claim',
    version: 1,
    phase: 2,
    action: 'need.claim',
    kind: 'change',
    title: 'Claim a need for your organization',
    usage: '/need <reference code> claim [note]',
    args: z.object({ note: z.string().max(500).optional() }),
    target: 'need',
    confirmation: 'one_tap',
    reversal: 'undo_15_min',
    freeText: ['note'],
    sideEffects: 'Marks the need claimed by your organization; others see who holds it.',
    request: (a, t) => ({
      method: 'POST',
      path: `/needs/${t!.id}/claim`,
      body: a.note ? { note: a.note } : {},
    }),
    undo: (_a, t) => ({
      method: 'POST',
      path: `/needs/${t!.id}/release`,
      body: { note: 'Undone from the command window' },
    }),
    describe: (a, t) =>
      `Claim the need ${t!.label} for your organization${a.note ? ` with the note "${a.note}"` : ''}.`,
    verify: (r) => {
      const n = ((r ?? {}) as Row)['need'] as Row | undefined;
      return {
        state: 'saved',
        summary:
          `Need ${str(n?.['referenceCode']) || ''} ${str(n?.['category']).replace(/_/g, ' ')} is now ${str(n?.['status'])}.`.replace(
            /\s+/g,
            ' ',
          ),
        records: n ? [{ kind: 'need', id: str(n['id']), version: ver(n['version']) }] : [],
      };
    },
  }),
  define({
    name: 'need.release',
    version: 1,
    phase: 2,
    action: 'need.release',
    kind: 'change',
    title: 'Release a need your organization holds',
    usage: '/need <reference code> release [note]',
    args: z.object({ note: z.string().max(500).optional() }),
    target: 'need',
    confirmation: 'one_tap',
    reversal: 'compensating',
    freeText: ['note'],
    sideEffects: 'The need goes back on the board for others to claim.',
    request: (a, t) => ({
      method: 'POST',
      path: `/needs/${t!.id}/release`,
      body: a.note ? { note: a.note } : {},
    }),
    describe: (_a, t) => `Release the need ${t!.label}.`,
    verify: (r) => {
      const n = ((r ?? {}) as Row)['need'] as Row | undefined;
      return {
        state: 'saved',
        summary: `Need ${str(n?.['referenceCode'])} is now ${str(n?.['status'])}.`,
        records: n ? [{ kind: 'need', id: str(n['id']), version: ver(n['version']) }] : [],
      };
    },
  }),
  define({
    name: 'reminder.create',
    version: 1,
    phase: 2,
    action: 'reminder.manage',
    kind: 'change',
    title: 'Set a reminder',
    usage: '/remind <in 30m | in 2h | HH:MM> <what>',
    args: z.object({ title: z.string().min(1).max(200), dueAt: z.iso.datetime() }),
    confirmation: 'one_tap',
    reversal: 'undo_15_min',
    freeText: ['title'],
    sideEffects: 'A reminder for you; it is escalated if nobody acknowledges it when due.',
    request: (a) => ({
      method: 'POST',
      path: '/reminders',
      body: { title: a.title, dueAt: a.dueAt },
    }),
    undo: (_a, _t, verified) => {
      const r = verified.records[0];
      return {
        method: 'POST',
        path: `/reminders/${r?.id ?? ''}/cancel`,
        body: { reason: 'Undone from the command window' },
        version: r?.version,
      };
    },
    describe: (a) => `Remind you "${a.title}" at ${a.dueAt}.`,
    verify: (r) => {
      const x = (r ?? {}) as Row;
      return {
        state: 'saved',
        summary: `Reminder "${str(x['title'])}" set for ${str(x['dueAt'])}.`,
        records: [
          {
            kind: 'reminder',
            id: str(x['id']),
            label: str(x['title']),
            version: ver(x['version']),
          },
        ],
      };
    },
  }),
  define({
    name: 'reminder.snooze',
    version: 1,
    phase: 2,
    action: 'reminder.manage',
    kind: 'change',
    title: 'Snooze a reminder',
    usage: '/reminder <title or number> snooze <minutes>',
    args: z.object({ minutes: z.number().int().min(1).max(10_080) }),
    target: 'reminder',
    confirmation: 'one_tap',
    reversal: 'compensating',
    sideEffects: 'The reminder comes back later; escalation waits with it.',
    request: (a, t) => ({
      method: 'POST',
      path: `/reminders/${t!.id}/snooze`,
      body: { minutes: a.minutes },
      version: t!.version,
    }),
    describe: (a, t) => `Snooze "${t!.label}" for ${plural(a.minutes, 'minute', 'minutes')}.`,
    verify: (r) => {
      const x = (r ?? {}) as Row;
      return {
        state: 'saved',
        summary: `"${str(x['title'])}" snoozed until ${str(x['snoozedUntil'])}.`,
        records: [{ kind: 'reminder', id: str(x['id']), version: ver(x['version']) }],
      };
    },
  }),
  define({
    name: 'reminder.complete',
    version: 1,
    phase: 2,
    action: 'reminder.manage',
    kind: 'change',
    title: 'Complete a reminder',
    usage: '/reminder <title> done <what was done>',
    args: z.object({ note: z.string().trim().min(1, 'Say what was done.').max(1000) }),
    target: 'reminder',
    confirmation: 'one_tap',
    reversal: 'compensating',
    freeText: ['note'],
    sideEffects: 'The reminder is closed as done; it does not come back.',
    request: (a, t) => ({
      method: 'POST',
      path: `/reminders/${t!.id}/complete`,
      // CMD-16: the note saying what was done is saved first; then the reminder completes.
      body: { completion: { kind: 'note', note: a.note } },
      version: t!.version,
    }),
    describe: (a, t) => `Mark "${t!.label}" done: "${a.note}".`,
    verify: (r) => {
      const x = (r ?? {}) as Row;
      return {
        state: 'saved',
        summary: `"${str(x['title'])}" is ${str(x['state'])}.`,
        records: [{ kind: 'reminder', id: str(x['id']), version: ver(x['version']) }],
      };
    },
  }),
  define({
    name: 'service.log',
    version: 1,
    phase: 2,
    action: 'service_log.write',
    kind: 'change',
    title: 'Log services given (meals, water, tarps …)',
    usage: '/log <count> <meals|water|tarps|cots|rides|people|vouchers|pet_food>',
    args: z.object({
      count: z.number().int().min(1).max(1000),
      kind: z.enum([
        'meal',
        'water_case',
        'tarp',
        'cot',
        'ride',
        'person_served',
        'voucher',
        'pet_food',
      ]),
    }),
    confirmation: 'one_tap',
    reversal: 'undo_15_min',
    sideEffects:
      'Adds to the service counts for the event; a correction is a new entry, never an edit (FL-06).',
    request: (a, _t, ctx) => ({
      method: 'POST',
      path: '/service-logs',
      body: { clientUuid: ctx.executionId, kind: a.kind, count: a.count },
    }),
    // A count is corrected by a counter-entry, as on the phone's counters.
    undo: (a) => ({
      method: 'POST',
      path: '/service-logs',
      body: {
        clientUuid: globalThis.crypto.randomUUID(),
        kind: a.kind,
        count: -a.count,
        note: 'Undone from the command window',
      },
    }),
    describe: (a) => `Log ${a.count} ${a.kind.replace(/_/g, ' ')}${a.count === 1 ? '' : 's'}.`,
    verify: (r) => {
      const x = (r ?? {}) as Row;
      const n = typeof x['count'] === 'number' ? x['count'] : 0;
      return {
        state: 'saved',
        summary: `Logged ${n} ${str(x['kind']).replace(/_/g, ' ')}${n === 1 ? '' : 's'}.`,
        records: [{ kind: 'service_log', id: str(x['id']) }],
      };
    },
  }),
  define({
    name: 'shift.end',
    version: 1,
    phase: 2,
    action: 'check_in.end',
    kind: 'change',
    title: 'Check out at the end of your shift',
    usage: '/checkout',
    args: z.object({}),
    target: 'check_in',
    confirmation: 'one_tap',
    reversal: 'none',
    sideEffects:
      'Ends your check-in and puts you off duty. To leave a hand-over for the next shift, use the check-out screen (FL-12).',
    request: (_a, t) => ({
      method: 'POST',
      path: `/check-ins/${t!.id}/end`,
      body: { reason: 'checked_out' },
    }),
    describe: (_a, t) => `Check out (${t!.label}).`,
    verify: (r) => {
      const c = (r ?? {}) as Row;
      const hours = typeof c['hours'] === 'number' ? Math.round(c['hours'] * 10) / 10 : null;
      return {
        state: 'saved',
        summary: `Checked out${hours !== null ? ` after ${hours} hours` : ''}. You are off duty.`,
        records: [{ kind: 'check_in', id: str(c['id']) }],
      };
    },
  }),
  define({
    name: 'mission.note',
    version: 1,
    phase: 2,
    action: 'mission.narrative',
    kind: 'change',
    title: 'Add a note to a mission',
    usage: '/mission <reference> note <text>',
    args: z.object({
      text: z.string().min(1).max(8000),
      role: z
        .enum(['call_taker', 'dispatcher', 'responder', 'supervisor', 'follow_up'])
        .default('dispatcher'),
    }),
    target: 'mission',
    confirmation: 'one_tap',
    reversal: 'compensating',
    freeText: ['text'],
    sideEffects:
      'A narrative entry on the mission timeline; corrected by an amending entry, never deleted.',
    request: (a, t) => ({
      method: 'POST',
      path: `/missions/${t!.id}/narratives`,
      body: { role: a.role, body: a.text },
    }),
    describe: (a, t) => `Add to mission ${t!.label}: "${a.text}".`,
    verify: (r) => {
      const e = (r ?? {}) as Row;
      return {
        state: 'saved',
        summary: 'The note is on the mission timeline.',
        records: e['id'] ? [{ kind: 'mission_event', id: str(e['id']) }] : [],
      };
    },
  }),

  // ---------------------------------------------------------------- phase 3: status and assignments
  define({
    name: 'mission.status',
    version: 1,
    phase: 3,
    action: 'mission.transition',
    kind: 'change',
    title: "Change a mission's status",
    usage: '/mission <reference> status <open|en_route|on_scene|cleared>',
    args: z.object({ to: z.enum(MISSION_STATES), reason: z.string().max(500).optional() }),
    target: 'mission',
    confirmation: 'one_tap',
    reversal: 'compensating',
    freeText: ['reason'],
    sideEffects: 'Changes the mission state on the dispatch board; the field app sees it.',
    request: (a, t) => ({
      method: 'POST',
      path: `/missions/${t!.id}/transitions`,
      body: { to: a.to, ...(a.reason ? { reason: a.reason } : {}) },
      version: t!.version,
    }),
    describe: (a, t) => `Move mission ${t!.label} to ${a.to.replace('_', ' ')}.`,
    verify: (r) => {
      const m = (r ?? {}) as Row;
      return {
        state: 'saved',
        summary: `Mission ${str(m['reference'])} is ${str(m['state']).replace('_', ' ')}.`,
        records: [
          {
            kind: 'mission',
            id: str(m['id']),
            label: str(m['reference']),
            version: ver(m['version']),
          },
        ],
      };
    },
  }),
  define({
    name: 'mission.priority',
    version: 1,
    phase: 3,
    action: 'mission.priority',
    kind: 'change',
    title: "Change a mission's priority",
    usage: '/mission <reference> priority <low|normal|high|urgent>',
    args: z.object({ priority: z.enum(['low', 'normal', 'high', 'urgent']) }),
    target: 'mission',
    confirmation: 'full_review',
    reversal: 'compensating',
    sideEffects:
      'Changes the priority on the dispatch board, with your reason on the timeline and in the significant-events log.',
    request: (a, t) => ({
      method: 'POST',
      path: `/missions/${t!.id}/priority`,
      body: { priority: a.priority },
      version: t!.version,
    }),
    describe: (a, t) => `Set mission ${t!.label} to ${a.priority} priority.`,
    verify: (r) => {
      const m = (r ?? {}) as Row;
      return {
        state: 'saved',
        summary: `Mission ${str(m['reference'])} is now ${str(m['priority'])} priority.`,
        records: [
          {
            kind: 'mission',
            id: str(m['id']),
            label: str(m['reference']),
            version: ver(m['version']),
          },
        ],
      };
    },
  }),
  define({
    name: 'mission.assign',
    version: 1,
    phase: 3,
    action: 'assignment.create',
    kind: 'change',
    title: 'Assign a person to a mission',
    usage: '/mission <reference> assign <person>',
    args: z.object({ person: z.string().min(1).max(120), personId: z.uuid().optional() }),
    target: 'mission',
    person: true,
    confirmation: 'one_tap',
    reversal: 'compensating',
    freeText: ['person'],
    sideEffects:
      'Assigns the person with the same checks as the dispatch board (CMD-14): a conflict stops it, and only an authorized override on the board can accept one.',
    request: (a, t) => ({
      method: 'POST',
      path: `/missions/${t!.id}/assignments`,
      body: { resources: [{ kind: 'person', id: a.personId }] },
    }),
    describe: (a, t) => `Assign ${a.person} to mission ${t!.label}.`,
    verify: (r) => {
      const list = rows(r);
      return {
        state: 'saved',
        summary: list.length
          ? `Assigned; the assignment is ${str(list[0]!['state']).replace('_', ' ')}.`
          : 'Nothing was assigned.',
        records: list.map((x) => ({
          kind: 'assignment',
          id: str(x['id']),
          version: ver(x['version']),
        })),
      };
    },
  }),
  // CMD-14, Section 30.2 phase 3: a person's duty status or availability, as the roster
  // records it. "Assigned" comes from an assignment, never from here.
  define({
    name: 'person.status',
    version: 1,
    phase: 3,
    action: 'personnel.update',
    kind: 'change',
    title: "Change a person's duty status or availability",
    usage: '/person <name> <available|unavailable|on duty|off duty>',
    args: z.object({ set: z.enum(PERSON_SETTINGS) }),
    target: 'personnel',
    confirmation: 'one_tap',
    reversal: 'undo_15_min',
    sideEffects:
      'Changes the roster entry the dispatch board reads. Missions the person is already assigned to are not changed; the board shows any conflict.',
    request: (a, t) => ({
      method: 'PATCH',
      path: `/personnel/${t!.id}`,
      body: { [PERSON_FIELD[a.set]]: a.set },
      version: t!.version,
    }),
    // Puts back what the plan saw; a change made since then is refused by the version check.
    undo: (a, t, v) => ({
      method: 'PATCH',
      path: `/personnel/${t!.id}`,
      body: { [PERSON_FIELD[a.set]]: t!.was?.[PERSON_FIELD[a.set]] },
      version: v.records[0]?.version,
    }),
    describe: (a, t) => {
      const field = PERSON_FIELD[a.set];
      const already = t!.was?.[field] === a.set;
      return `${already ? 'Keep' : 'Mark'} ${t!.label} ${a.set.replace('_', ' ')}${already ? '; that is already recorded' : ''}.`;
    },
    verify: (r) => {
      const p = (r ?? {}) as Row;
      return {
        state: 'saved',
        summary: `${str(p['name'])} is ${str(p['dutyStatus']).replace('_', ' ')} and ${str(p['availability'])}.`,
        records: [
          {
            kind: 'personnel',
            id: str(p['id']),
            label: str(p['name']),
            version: ver(p['version']),
          },
        ],
      };
    },
  }),
  define({
    name: 'mission.close',
    version: 1,
    phase: 3,
    action: 'mission.close',
    kind: 'change',
    title: 'Close a mission',
    usage:
      '/mission <reference> close [disposition:<completed|referred|no_action_needed|unable_to_locate|duplicate|transferred|other>]',
    args: z.object({
      disposition: z
        .enum([
          'completed',
          'referred',
          'no_action_needed',
          'unable_to_locate',
          'duplicate',
          'transferred',
          'other',
        ])
        .default('completed'),
    }),
    target: 'mission',
    confirmation: 'full_review',
    reversal: 'compensating',
    sideEffects:
      'Closes the mission with your reason and releases everyone still assigned; reopening it needs its own reason.',
    request: (a, t) => ({
      method: 'POST',
      path: `/missions/${t!.id}/close`,
      body: { disposition: a.disposition },
      version: t!.version,
    }),
    describe: (a, t) => `Close mission ${t!.label} as ${a.disposition.replace(/_/g, ' ')}.`,
    verify: (r) => {
      const m = (r ?? {}) as Row;
      return {
        state: 'saved',
        summary: `Mission ${str(m['reference'])} is ${str(m['state'])}.`,
        records: [
          {
            kind: 'mission',
            id: str(m['id']),
            label: str(m['reference']),
            version: ver(m['version']),
          },
        ],
      };
    },
  }),
  define({
    name: 'mission.reopen',
    version: 1,
    phase: 3,
    action: 'mission.reopen',
    kind: 'change',
    title: 'Reopen a mission',
    usage: '/mission <reference> reopen',
    args: z.object({}),
    target: 'mission',
    confirmation: 'full_review',
    reversal: 'compensating',
    sideEffects: 'Reopens a closed or canceled mission with your reason on its timeline.',
    request: (_a, t) => ({
      method: 'POST',
      path: `/missions/${t!.id}/reopen`,
      body: {},
      version: t!.version,
    }),
    describe: (_a, t) => `Reopen mission ${t!.label}.`,
    verify: (r) => {
      const m = (r ?? {}) as Row;
      return {
        state: 'saved',
        summary: `Mission ${str(m['reference'])} is ${str(m['state'])} again.`,
        records: [
          {
            kind: 'mission',
            id: str(m['id']),
            label: str(m['reference']),
            version: ver(m['version']),
          },
        ],
      };
    },
  }),
  // ---------------------------------------------------------------- phase 4: batches (CMD-30)
  define({
    name: 'needs.claim_many',
    version: 1,
    phase: 4,
    action: 'need.claim',
    kind: 'change',
    title: 'Claim the open needs a filter names, for your organization',
    usage: '/needs open [category:<category>] [postal:<code>] claim [note]',
    args: z.object({
      category: z.string().min(2).max(60).optional(),
      postal: z.string().min(3).max(12).optional(),
      note: z.string().max(500).optional(),
    }),
    target: 'need',
    confirmation: 'full_review',
    reversal: 'compensating',
    freeText: ['note'],
    sideEffects:
      'Claims each open need the filter names for your organization, one at a time. A need someone else claims first is left as it is and named in the result. To give them back, release them the same way.',
    bulk: {
      list: (a) =>
        `/needs?status=open${a.category ? `&category=${encodeURIComponent(a.category)}` : ''}${a.postal ? `&postal=${encodeURIComponent(a.postal)}` : ''}`,
      item: (a, t) => ({
        method: 'POST',
        path: `/needs/${t.id}/claim`,
        body: a.note ? { note: a.note } : {},
      }),
      describe: (a, n, sample) =>
        `Claim ${plural(n, 'open need', 'open needs')}${a.category ? ` in ${a.category.replace(/_/g, ' ')}` : ''}${a.postal ? ` in ${a.postal}` : ''} for your organization: ${sample.join(', ')}${n > sample.length ? ` and ${n - sample.length} more` : ''}.`,
      done: (n, of) => `Claimed ${n} of ${plural(of, 'need', 'needs')}.`,
    },
    request: () => {
      throw new Error('a batch runs one operation per record');
    },
    describe: () => 'Claim needs.',
    verify: () => ({ state: 'saved', summary: '', records: [] }),
  }),
  define({
    name: 'needs.release_many',
    version: 1,
    phase: 4,
    action: 'need.release',
    kind: 'change',
    title: 'Release the needs your organization holds that a filter names',
    usage: '/needs claimed [category:<category>] [postal:<code>] release [note]',
    args: z.object({
      category: z.string().min(2).max(60).optional(),
      postal: z.string().min(3).max(12).optional(),
      note: z.string().max(500).optional(),
    }),
    target: 'need',
    confirmation: 'full_review',
    reversal: 'compensating',
    freeText: ['note'],
    sideEffects:
      'Puts each need your organization holds that the filter names back on the board, one at a time; others can then claim them.',
    bulk: {
      list: (a, ctx) =>
        `/needs?status=claimed&claimedBy=${ctx.tenantId}${a.category ? `&category=${encodeURIComponent(a.category)}` : ''}${a.postal ? `&postal=${encodeURIComponent(a.postal)}` : ''}`,
      item: (a, t) => ({
        method: 'POST',
        path: `/needs/${t.id}/release`,
        body: a.note ? { note: a.note } : {},
      }),
      describe: (a, n, sample) =>
        `Release ${plural(n, 'need', 'needs')} your organization holds${a.category ? ` in ${a.category.replace(/_/g, ' ')}` : ''}${a.postal ? ` in ${a.postal}` : ''}: ${sample.join(', ')}${n > sample.length ? ` and ${n - sample.length} more` : ''}.`,
      done: (n, of) => `Released ${n} of ${plural(of, 'need', 'needs')}.`,
    },
    request: () => {
      throw new Error('a batch runs one operation per record');
    },
    describe: () => 'Release needs.',
    verify: () => ({ state: 'saved', summary: '', records: [] }),
  }),

  // CMD-13, Section 30.2 phase 1: a mission draft for the open event; nothing is dispatched.
  define<{ kind: (typeof MISSION_KINDS)[number]; summary: string }>({
    name: 'mission.draft',
    version: 1,
    phase: 1,
    action: 'mission.create',
    kind: 'draft',
    title: 'Draft a mission',
    usage: '/mission new <kind> <what is needed>',
    args: z.object({
      kind: z.enum(MISSION_KINDS),
      summary: z.string().trim().min(3).max(500),
    }),
    needsEvent: true,
    confirmation: 'none',
    reversal: 'none',
    sideEffects:
      'Creates a draft mission in the open event. Nothing is dispatched until someone opens it on the missions screen.',
    freeText: ['summary'],
    request: (a, _t, ctx) => ({
      method: 'POST',
      path: '/missions',
      body: {
        eventId: ctx.eventId,
        kind: a.kind,
        source: 'staff',
        summary: a.summary,
        save: 'draft',
      },
    }),
    describe: (a) =>
      `Draft a ${a.kind.replace(/_/g, ' ')} mission in the open event with what you typed. Nothing is dispatched.`,
    verify: (r) => {
      const d = (r ?? {}) as Row;
      return {
        state: 'drafted',
        summary: `Mission ${str(d['reference'])} drafted. Nothing is dispatched until it is opened on the missions screen.`,
        records: [
          {
            kind: 'mission',
            id: str(d['id']),
            label: str(d['reference']),
            version: ver(d['version']),
          },
        ],
      };
    },
  }),

  // CMD-17, Section 30.2 phase 1: a resource drafted in English, the fallback language. It is
  // published on the Resources screen, after its texts are reviewed (BRD:FR-16.02).
  define({
    name: 'resource.draft',
    version: 1,
    phase: 1,
    action: 'resource.edit',
    kind: 'draft',
    title: 'Draft a resource',
    usage: '/resource new <hotline|program|deadline|guidance|link|document> <title>',
    args: z.object({
      type: z.enum(RESOURCE_TYPES),
      title: z.string().trim().min(3).max(200),
      summary: z.string().trim().max(500).optional(),
      category: z
        .string()
        .regex(/^[a-z0-9_]{1,60}$/)
        .optional(),
    }),
    confirmation: 'none',
    reversal: 'none',
    sideEffects:
      'Creates a draft resource with an English title. Nobody sees it until its texts are reviewed and it is published on the Resources screen.',
    freeText: ['title', 'summary'],
    request: (a) => ({
      method: 'POST',
      path: '/resources',
      body: {
        type: a.type,
        ...(a.category ? { category: a.category } : {}),
        texts: {
          en: { title: a.title, summary: a.summary ?? null, bodyHtml: '', humanReviewed: false },
        },
      },
    }),
    describe: (a) =>
      `Draft a ${a.type} resource${a.category ? ` in ${a.category.replace(/_/g, ' ')}` : ''} with the title you typed. Nobody sees it until it is published.`,
    verify: (r) => {
      const d = (r ?? {}) as Row;
      return {
        state: 'drafted',
        summary: `Resource "${str(d['slug'])}" drafted. Add its texts and publish it on the Resources screen.`,
        records: [
          {
            kind: 'resource',
            id: str(d['id']),
            label: str(d['slug']),
            version: ver(d['version']),
          },
        ],
      };
    },
  }),
  // CMD-17, Section 30.2 phase 2: the date someone looks at a resource again. Internal only.
  define({
    name: 'resource.review',
    version: 1,
    phase: 2,
    action: 'resource.edit',
    kind: 'change',
    title: "Set a resource's review date",
    usage: '/resource <slug or title> review <YYYY-MM-DD|none>',
    args: z.object({ value: z.iso.date().nullable() }),
    target: 'resource',
    confirmation: 'one_tap',
    reversal: 'undo_15_min',
    sideEffects:
      'Changes the date the resource comes up for review. The public page does not change.',
    request: (a, t) => ({
      method: 'PATCH',
      path: `/resources/${t!.id}`,
      body: { reviewAt: a.value },
      version: t!.version,
    }),
    undo: (_a, t, v) => ({
      method: 'PATCH',
      path: `/resources/${t!.id}`,
      body: { reviewAt: t!.was?.['reviewAt'] || null },
      version: v.records[0]?.version,
    }),
    describe: (a, t) =>
      a.value
        ? `Set the review date of ${t!.label} to ${a.value}.`
        : `Clear the review date of ${t!.label}.`,
    verify: (r) => resourceSaved(r, 'review date', 'reviewAt'),
  }),
  // CMD-17, Section 30.2 phase 3: when a published page turns into "expired on". Only a future
  // time is taken (the parser refuses a past one); undo puts back what the plan saw.
  define({
    name: 'resource.expiry',
    version: 1,
    phase: 3,
    action: 'resource.edit',
    kind: 'change',
    title: "Set a resource's expiry",
    usage: '/resource <slug or title> expires <YYYY-MM-DD [HH:MM]|none>',
    args: z.object({
      value: z.iso.datetime().nullable(),
      local: z.string().max(80).optional(),
    }),
    target: 'resource',
    confirmation: 'one_tap',
    reversal: 'undo_15_min',
    sideEffects:
      'From that time the public page shows "expired on" instead of the resource. Without an expiry it stays until it is unpublished.',
    request: (a, t) => ({
      method: 'PATCH',
      path: `/resources/${t!.id}`,
      body: { expiresAt: a.value },
      version: t!.version,
    }),
    undo: (_a, t, v) => ({
      method: 'PATCH',
      path: `/resources/${t!.id}`,
      body: { expiresAt: t!.was?.['expiresAt'] || null },
      version: v.records[0]?.version,
    }),
    describe: (a, t) =>
      a.value
        ? `Expire ${t!.label} at ${a.local ?? a.value}; until then the public page is unchanged.`
        : `Remove the expiry of ${t!.label}; it stays published until someone unpublishes it.`,
    verify: (r) => resourceSaved(r, 'expiry', 'expiresAt'),
  }),

  // AC-C08, Section 30.2 phase 4 (outbound messages): a message to a team's phones, reviewed
  // with a reason. It is answered as sent, never as delivered: delivery is each phone's receipt.
  define<{ text: string }>({
    name: 'team.message',
    version: 1,
    phase: 4,
    action: 'field_message.send',
    kind: 'change',
    title: 'Message a team in the field',
    usage: '/message <team> <text>',
    args: z.object({ text: z.string().trim().min(1).max(1000) }),
    target: 'team',
    needsEvent: true,
    confirmation: 'full_review',
    reversal: 'compensating',
    sideEffects:
      "Sends the message to each team member's phone, in the field app or by text where they have no app. A sent message cannot be unsent; a correction is a new message.",
    freeText: ['text'],
    undoUnavailable:
      "A sent message cannot be recalled from people's phones. Send a correction as a new message.",
    request: (a, t, ctx) => ({
      method: 'POST',
      path: '/field-messages',
      body: {
        eventId: ctx.eventId,
        kind: 'message',
        body: a.text,
        audience: { kind: 'team', teamId: t!.id },
      },
    }),
    describe: (_a, t) =>
      `Send what you typed to ${t?.label ?? 'the team'}. It shows as delivered only when their phones confirm it.`,
    verify: (r) => {
      const d = (r ?? {}) as Row;
      const n = typeof d['recipientCount'] === 'number' ? d['recipientCount'] : 0;
      return {
        state: 'queued',
        summary: `Sent to ${plural(n, 'person', 'people')}. Not yet delivered: the messages screen shows each phone's receipt as it arrives.`,
        records: [{ kind: 'field_message', id: str(d['id']) }],
      };
    },
  }),

  // CMD-15: a reviewer takes a report into review (phase 3), and decides it or asks the
  // resident (phase 4: approvals and messages, reviewed with a reason, RULE-14). The author of
  // a report never reviews it (A7); the route's own guardrail refuses it.
  define<Record<string, never>>({
    name: 'report.claim',
    version: 1,
    phase: 3,
    action: 'report.update',
    kind: 'change',
    title: 'Take a report into review',
    usage: '/report <reference code> review',
    args: z.object({}),
    target: 'report',
    confirmation: 'one_tap',
    reversal: 'none',
    sideEffects: 'Marks the report under review. No decision is made and the resident is not told.',
    request: (_a, t) => ({ method: 'POST', path: `/reports/${t!.id}/claim`, version: t!.version }),
    describe: (_a, t) => `Take ${t?.label ?? 'the report'} into review. No decision is made.`,
    verify: (r) => reviewed(r, 'is under review'),
  }),
  ...(['approve', 'reject'] as const).map((decision) =>
    define<{ reason: string; evidenceRefs: string[] }>({
      name: `report.${decision}`,
      version: 1,
      phase: 4,
      action: 'report.review',
      kind: 'change',
      title: decision === 'approve' ? 'Approve a report' : 'Reject a report',
      usage: `/report <reference code> ${decision} <why> [evidence:<ref>,<ref>]`,
      args: z.object({
        reason: z.string().trim().min(3).max(2000),
        evidenceRefs: z.array(z.string().trim().min(1).max(200)).max(20).default([]),
      }),
      target: 'report',
      confirmation: 'full_review',
      reversal: 'compensating',
      sideEffects:
        decision === 'approve'
          ? "Records the review decision with your reason and evidence. The report's verification level does not change: a public observation is not a verified assessment until someone verifies it."
          : 'Records the review decision with your reason and evidence. The report stays on record; reopening it is a new decision.',
      freeText: ['reason'],
      request: (a, t) => ({
        method: 'POST',
        path: `/reports/${t!.id}/decisions`,
        version: t!.version,
        body: { decision, reason: a.reason, evidenceRefs: a.evidenceRefs },
      }),
      describe: (a, t) =>
        `${decision === 'approve' ? 'Approve' : 'Reject'} ${t?.label ?? 'the report'}${a.evidenceRefs.length ? `, citing ${a.evidenceRefs.join(', ')}` : ''}. The verification level stays as it is.`,
      verify: (r) => reviewed(r, decision === 'approve' ? 'is approved' : 'is rejected'),
    }),
  ),
  define<{ message: string }>({
    name: 'report.ask',
    version: 1,
    phase: 4,
    action: 'report.review',
    kind: 'change',
    title: 'Ask the resident for more information',
    usage: '/report <reference code> ask <question>',
    args: z.object({ message: z.string().trim().min(3).max(2000) }),
    target: 'report',
    confirmation: 'full_review',
    reversal: 'compensating',
    sideEffects:
      "Marks the report as needing information and sends the resident your question in their language, through the county's number. A sent message cannot be unsent; a correction is a new message.",
    freeText: ['message'],
    request: (a, t) => ({
      method: 'POST',
      path: `/reports/${t!.id}/decisions`,
      version: t!.version,
      body: {
        decision: 'needs_information',
        reason: 'More information asked of the resident',
        message: a.message,
      },
    }),
    describe: (_a, t) =>
      `Ask the resident who sent ${t?.label ?? 'the report'} for more information. They are sent your question.`,
    verify: (r) => reviewed(r, 'needs information; the question is queued for the resident'),
  }),

  // CMD-16: exports with an explicit scope and period. Section 30.2 lists exports with
  // neither lookups nor drafts, so they are confirmed and sit in phase 3 (IDA package, an
  // issued report) and phase 4 (a public-records release, reviewed with a reason, RULE-14).
  define<Record<string, never>>({
    name: 'ida.export',
    version: 1,
    phase: 3,
    action: 'declaration.export',
    kind: 'change',
    title: 'Prepare the IDA package',
    usage: '/export ida',
    args: z.object({}),
    needsEvent: true,
    confirmation: 'one_tap',
    reversal: 'none',
    sideEffects:
      'Builds the IDA package of the open event (counts and generalized places, no personal details) from the records as they stand when it is built. It is not sent to FEMA or anyone else.',
    request: (_a, _t, ctx) => ({
      method: 'POST',
      path: `/events/${ctx.eventId ?? ''}/exports`,
      body: { clientUuid: ctx.executionId },
    }),
    describe: () =>
      'Prepare the IDA package for the open event. Scope: every jurisdiction in the event. Period: the whole event, up to when the package is built.',
    verify: queuedExport('The IDA package', 'Declaration data', (d) => ({
      kind: 'ida_package',
      id: str(d['id']),
    })),
  }),

  define<{ format: 'pdf' | 'csv' }>({
    name: 'report.export',
    version: 1,
    phase: 3,
    action: 'official_report.export',
    kind: 'change',
    title: 'Export an issued report',
    usage: '/export sitrep|briefing [number|latest] [pdf|csv]',
    args: z.object({ format: z.enum(['pdf', 'csv']).default('pdf') }),
    target: 'official_report',
    confirmation: 'one_tap',
    reversal: 'none',
    sideEffects:
      'Builds a file of the report as it was issued, from its frozen copy (RULE-10); drafts are never exported. It is not sent anywhere.',
    request: (a, t, ctx) => ({
      method: 'POST',
      path: `/official-reports/${t!.id}/exports`,
      body: { clientUuid: ctx.executionId, format: a.format },
    }),
    describe: (a, t) =>
      `Export ${t?.label ?? 'the report'} as ${a.format.toUpperCase()}. Scope and period: the report as issued.`,
    verify: queuedExport('The report file', 'the report', (d) => ({
      kind: 'official_report',
      id: str(d['reportId']),
    })),
  }),

  define<{
    requestReference: string;
    recordTypes: RecordType[];
    from?: string | undefined;
    to?: string | undefined;
  }>({
    name: 'public_records.export',
    version: 1,
    phase: 4,
    action: 'public_records.export',
    kind: 'change',
    title: 'Prepare a public-records release',
    usage: '/export records <request> <kinds> [from:YYYY-MM-DD] [to:YYYY-MM-DD]',
    args: z
      .object({
        requestReference: z.string().trim().min(1).max(80),
        recordTypes: z.array(z.enum(RECORD_TYPE_KEYS as [RecordType, ...RecordType[]])).min(1),
        from: z.iso.date().optional(),
        to: z.iso.date().optional(),
      })
      .refine((a) => !a.from || !a.to || a.from < a.to, {
        message: 'The period ends before it starts.',
      }),
    needsEvent: true,
    confirmation: 'full_review',
    reversal: 'none',
    sideEffects:
      'Builds a ZIP of the kinds of record named, for the open event and the period, with restricted, sensitive and criminal-justice details withheld column by column. A person reviews it before anything is released.',
    // A request reference is what the records office typed; it may carry a requester's name.
    freeText: ['requestReference'],
    request: (a, _t, ctx) => ({
      method: 'POST',
      path: `/events/${ctx.eventId ?? ''}/public-records`,
      body: {
        clientUuid: ctx.executionId,
        requestReference: a.requestReference,
        recordTypes: a.recordTypes,
        ...(a.from ? { from: a.from } : {}),
        ...(a.to ? { to: a.to } : {}),
      },
    }),
    describe: (a) =>
      `Prepare a public-records release for request ${a.requestReference}. Scope: ${a.recordTypes
        .map((t) => RECORD_TYPES[t].label.toLowerCase())
        .join(
          ', ',
        )} in the open event. Period: ${a.from || a.to ? `${a.from ?? 'the start of the event'} to ${a.to ?? 'now'}` : 'the whole event'}. Restricted, sensitive and criminal-justice details are withheld.`,
    verify: queuedExport('The public-records release', 'Records requests', (d) => ({
      kind: 'public_records',
      id: str(d['id']),
    })),
  }),
] satisfies readonly CommandSpec[];

export function commandByName(name: string): CommandSpec | undefined {
  return CATALOG.find((c) => c.name === name);
}

/** Section 30.2 as approved 2026-10-15: phases 1 and 2 on by default; 3 and 4 per county. */
export const DEFAULT_PHASES = [1, 2] as const;
