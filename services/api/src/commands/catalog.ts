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

export type Confirmation = 'none' | 'one_tap' | 'full_review' | 'second_person';
export type Reversal = 'undo_15_min' | 'compensating' | 'none';
export type TargetKind = 'mission' | 'need' | 'reminder';

/** A resolved record the command acts on, with the version it had when the plan was made. */
export interface Target {
  kind: TargetKind;
  id: string;
  version: number;
  label: string;
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
  /** Undo from what the plan targeted and what the operation verified; never from free text. */
  undo?(args: A, target: Target | null, verified: Verified): OpRequest;
  describe(args: A, target: Target | null): string;
  verify(response: unknown): Verified;
}

const MISSION_STATES = ['open', 'en_route', 'on_scene', 'cleared'] as const;

type Row = Record<string, unknown>;
const rows = (r: unknown): Row[] => (Array.isArray(r) ? (r as Row[]) : []);
const str = (v: unknown) => (typeof v === 'string' ? v : '');
const ver = (v: unknown) => (typeof v === 'number' ? v : undefined);
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

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
] satisfies readonly CommandSpec[];

export function commandByName(name: string): CommandSpec | undefined {
  return CATALOG.find((c) => c.name === name);
}

/** Section 30.2 as approved 2026-10-15: phases 1 and 2 on by default; 3 and 4 per county. */
export const DEFAULT_PHASES = [1, 2] as const;
