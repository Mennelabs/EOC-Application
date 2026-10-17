/**
 * The command window's engine (layer-7 task B; ADR-0044; CMD-08, CMD-09,
 * CMD-10, CMD-12, CMD-20–CMD-28, CMD-37, BRD:FR-C03–C07, BP-05, NFR-11,
 * AC-C02, AC-C04–C08, Section 30.2).
 *
 * POST /commands prepares a plan from shorthand: the catalogued command, its
 * checked arguments, the one record it acts on (resolved through the console's
 * own list operations, so only records the person may see are matched; more
 * than one asks which) and the version that record had. Lookups and drafts run
 * at once (no confirmation, Section 30.2); a change waits for a confirmation
 * bound to the plan's hash. Confirming re-reads the record and refuses a plan
 * whose record changed (CMD-09), then calls the console's own operation in
 * process with the person's own credentials, the execution id as the
 * idempotency key and the expected version: validation, authorization, locks,
 * versions and audit are the manual path's (CMD-21, CMD-23). The result is
 * what that operation answered (CMD-26). A change that can be undone can be,
 * for 15 minutes, as a linked execution (CMD-28, AC-08C).
 */
import { createHash, randomUUID } from 'node:crypto';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { sql, type Selectable, type Transaction } from 'kysely';
import { z } from 'zod';
import {
  AiProviderError,
  callAi,
  recordAiOutput,
  recordHumanAction,
  redact,
  type AiProvider,
} from '@cg/ai';
import { actions, decide, isActionKey } from '@cg/authz';
import type { CommandExecutionTable, Database } from '@cg/db';
import {
  BATCH_MAX,
  BATCH_ONE_CONFIRMATION,
  CATALOG,
  commandByName,
  DEFAULT_PHASES,
  type CommandSpec,
  type OpRequest,
  type Target,
  type TargetKind,
  type Verified,
} from '../commands/catalog.ts';
import { aliasMayRun, type AliasScope } from '../commands/aliases.ts';
import { ON_SCREEN, parseShorthand } from '../commands/parse.ts';
import { DEADLINE_MS, TARGETS, p95, within } from '../commands/timing.ts';
import { ApiError, errors } from '../errors.ts';
import { iso, uuidParam } from './helpers.ts';

type Row = Selectable<CommandExecutionTable>;

/** Section 30.2: no more than 30 consequential commands a minute per person. */
const RATE_PER_MINUTE = 30;
/** Section 30.2: one-click undo for 15 minutes on reversible internal changes. */
const UNDO_MS = 15 * 60_000;
/** A plan waiting longer than this is prepared again rather than confirmed (CMD-09). */
const PLAN_TTL_MS = 15 * 60_000;

const statuses = [
  'help',
  'unsupported',
  'clarify',
  'not_found',
  'denied',
  'awaiting_confirmation',
  'executing',
  'succeeded',
  'partially_succeeded',
  'failed',
  'canceled',
  'stale',
] as const;
type Status = (typeof statuses)[number];

const commandMeta = z.object({
  name: z.string(),
  title: z.string(),
  usage: z.string(),
  phase: z.number().int(),
  kind: z.enum(['lookup', 'draft', 'change']),
  confirmation: z.enum(['none', 'one_tap', 'full_review', 'second_person']),
  reversal: z.enum(['undo_15_min', 'compensating', 'none']),
  sideEffects: z.string(),
});

const targetOut = z.object({
  kind: z.string(),
  id: z.uuid(),
  label: z.string(),
  version: z.number().int(),
});

const verifiedOut = z.object({
  state: z.enum(['found', 'drafted', 'saved', 'queued']),
  summary: z.string().nullable(),
  records: z.array(
    z.object({
      kind: z.string(),
      id: z.string(),
      label: z.string().optional(),
      version: z.number().int().optional(),
    }),
  ),
  /** CMD-30: records of a batch that were not changed, and why. */
  failures: z
    .array(z.object({ id: z.string(), label: z.string(), code: z.string(), message: z.string() }))
    .optional(),
});

const executionOut = z.object({
  id: z.uuid().nullable(),
  executionId: z.uuid(),
  status: z.enum(statuses),
  message: z.string(),
  usage: z.string().nullable(),
  command: commandMeta.nullable(),
  plan: z
    .object({
      description: z.string(),
      args: z.record(z.string(), z.unknown()),
      target: targetOut.nullable(),
      eventId: z.uuid().nullable(),
      interpretation: z.string().nullable(),
      /** CMD-30: how many records a batch covers; over 50, the count is typed to confirm. */
      count: z.number().int().nullable(),
    })
    .nullable(),
  planHash: z.string().nullable(),
  /** CMD-08: the authorized matches to choose from. */
  options: z.array(z.object({ kind: z.string(), id: z.uuid(), label: z.string() })),
  result: verifiedOut.nullable(),
  error: z.object({ status: z.number().int(), code: z.string(), message: z.string() }).nullable(),
  undoUntil: z.iso.datetime().nullable(),
  reversalOf: z.uuid().nullable(),
  undoneBy: z.uuid().nullable(),
  createdAt: z.iso.datetime().nullable(),
  /** For /help: the commands this person can use here. */
  commands: z.array(commandMeta.extend({ enabled: z.boolean(), allowed: z.boolean() })),
  /** For /help: the aliases this person can use (CMD-04). */
  aliases: z.array(
    z.object({
      name: z.string(),
      expansion: z.string(),
      scope: z.enum(['personal', 'organization']),
    }),
  ),
});
type ExecutionOut = z.infer<typeof executionOut>;

interface Plan {
  command: string;
  version: number;
  args: Record<string, unknown>;
  target: Target | null;
  eventId: string | null;
  /** CMD-10: the shorthand plain words were read as, shown with the plan. */
  interpretation?: string;
  /** CMD-30: the records a batch covers, as they were when the plan was made. */
  batch?: Target[];
}

interface StoredResult {
  httpStatus: number;
  verified?: Verified;
  error?: { code: string; message: string };
}

const meta = (spec: CommandSpec): z.infer<typeof commandMeta> => ({
  name: spec.name,
  title: spec.title,
  usage: spec.usage,
  phase: spec.phase,
  kind: spec.kind,
  confirmation: spec.confirmation,
  reversal: spec.reversal,
  sideEffects: spec.sideEffects,
});

function blank(executionId: string, status: Status, message: string): ExecutionOut {
  return {
    id: null,
    executionId,
    status,
    message,
    usage: null,
    command: null,
    plan: null,
    planHash: null,
    options: [],
    result: null,
    error: null,
    undoUntil: null,
    reversalOf: null,
    undoneBy: null,
    createdAt: null,
    commands: [],
    aliases: [],
  };
}

/** Sorted keys all the way down, so the same plan always hashes the same. */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object')
    return `{${Object.keys(v)
      .sort()
      .filter((k) => (v as Record<string, unknown>)[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`)
      .join(',')}}`;
  return JSON.stringify(v ?? null);
}

/** FR-C05, AC-C04: the confirmation is bound to the plan, the person and the scope. */
const planHash = (plan: Plan, tenantId: string, accountId: string) =>
  createHash('sha256').update(canonical({ plan, tenantId, accountId })).digest('hex');

/** CMD-37, NFR-10: once run, free text stays in the record it was saved to, not here. */
function withoutFreeText(plan: Plan, spec: CommandSpec | undefined): Plan {
  if (!spec?.freeText?.length) return plan;
  const args = { ...plan.args };
  for (const k of spec.freeText) {
    const v = args[k];
    if (typeof v === 'string')
      args[k] = {
        digest: createHash('sha256').update(v).digest('hex').slice(0, 16),
        length: v.length,
      };
  }
  return { ...plan, args };
}

function statusOf(row: Row, now: Date): Status {
  if (
    row.state === 'awaiting_confirmation' &&
    now.getTime() - row.created_at.getTime() > PLAN_TTL_MS
  )
    return 'stale';
  return row.state;
}

function messageFor(status: Status, spec: CommandSpec | undefined, result: StoredResult | null) {
  switch (status) {
    case 'awaiting_confirmation':
      return 'Check the plan, then confirm or cancel.';
    case 'executing':
      return 'Running. The result shows here when the operation answers.';
    case 'succeeded':
    case 'partially_succeeded':
      return result?.verified?.summary ?? `${spec?.title ?? 'The command'}: done.`;
    case 'failed':
      return result?.error?.message ?? 'The operation refused this. Nothing was changed.';
    case 'canceled':
      return 'Cancelled before anything ran.';
    case 'stale':
      return 'The record changed, or the plan waited too long. Prepare it again.';
    default:
      return '';
  }
}

function view(row: Row, now: Date, live?: Verified): ExecutionOut {
  const spec = commandByName(row.command);
  const plan = row.plan as unknown as Plan & { undoOf?: string };
  const stored = (row.result as StoredResult | null) ?? null;
  const status = statusOf(row, now);
  const verified = live ?? stored?.verified ?? null;
  return {
    ...blank(row.execution_id, status, ''),
    id: row.id,
    message: live?.summary ?? messageFor(status, spec, stored),
    usage: spec?.usage ?? null,
    command: spec ? meta(spec) : null,
    plan: {
      description: plan.undoOf
        ? `Undo: ${spec?.title ?? row.command}`
        : spec?.bulk && plan.batch
          ? spec.bulk.describe(
              plan.args,
              plan.batch.length,
              plan.batch.slice(0, 5).map((t) => t.label),
            )
          : spec
            ? spec.describe(plan.args, plan.target)
            : row.command,
      args: plan.args ?? {},
      target: plan.target ?? null,
      eventId: plan.eventId ?? null,
      interpretation: plan.interpretation ?? null,
      count: plan.batch?.length ?? null,
    },
    planHash: row.state === 'awaiting_confirmation' ? row.plan_hash : null,
    result: verified
      ? {
          state: verified.state,
          summary: verified.summary ?? null,
          records: verified.records,
          ...(verified.failures ? { failures: verified.failures } : {}),
        }
      : null,
    error:
      stored?.error && status === 'failed'
        ? { status: stored.httpStatus, code: stored.error.code, message: stored.error.message }
        : null,
    undoUntil:
      row.undo_until && !row.undone_by && row.undo_until.getTime() > now.getTime()
        ? iso(row.undo_until)
        : null,
    reversalOf: row.reversal_of,
    undoneBy: row.undone_by,
    createdAt: iso(row.created_at),
  };
}

/**
 * Calls a console operation in process with the person's own credentials
 * (ADR-0044): the same route, hooks, authorization, locks and audit as a click.
 */
async function op(
  request: FastifyRequest,
  req: OpRequest,
  extra: Record<string, string> = {},
): Promise<{ status: number; body: unknown }> {
  const headers: Record<string, string> = { ...extra };
  for (const h of ['authorization', 'cookie', 'accept-language'] as const) {
    const v = request.headers[h];
    if (typeof v === 'string') headers[h] = v;
  }
  if (req.version !== undefined) headers['if-match'] = `"${req.version}"`;
  const res = await request.server.inject({
    method: req.method,
    url: `/api/v1${req.path}`,
    headers,
    ...(req.body ? { payload: req.body } : {}),
  });
  let body: unknown;
  try {
    body = res.json();
  } catch {
    body = null;
  }
  return { status: res.statusCode, body };
}

const errorOf = (status: number, body: unknown): { code: string; message: string } => {
  const b = (body ?? {}) as { code?: unknown; message?: unknown };
  // A denial or a missing record says nothing more than the manual path would (AC-C03).
  if (status === 403 || status === 404)
    return { code: 'not_available', message: 'That is not available to you, or no longer exists.' };
  return {
    code: typeof b.code === 'string' ? b.code : 'failed',
    message: typeof b.message === 'string' ? b.message : 'The operation refused this.',
  };
};

type Resolution =
  | { kind: 'one'; target: Target }
  | { kind: 'many'; options: { kind: string; id: string; label: string }[] }
  | { kind: 'none' };

type ListRow = Record<string, unknown>;
const str = (v: unknown) => (typeof v === 'string' ? v : '');

/** A UUID-shaped idempotency key for one part of an execution (a batch record, a second step). */
const derivedKey = (executionId: string, part: string) => {
  const key = createHash('sha256').update(`${executionId}:${part}`).digest('hex');
  return `${key.slice(0, 8)}-${key.slice(8, 12)}-5${key.slice(13, 16)}-a${key.slice(17, 20)}-${key.slice(20, 32)}`;
};

/** FR-C11: requests answered with an earlier execution again (CMD-25), counted as duplicates. */
const replays = new WeakSet<FastifyRequest>();

/**
 * FR-C11, CMD-38: one more of this outcome today. Only the catalogued command's name, the
 * kind of input and the outcome are counted: no account, words or record. Counting never
 * fails the request it counts.
 */
async function countOutcome(
  request: FastifyRequest,
  command: string,
  inputKind: string,
  outcome: string,
): Promise<void> {
  const s = request.subject;
  if (s.kind !== 'account') return;
  const kind = inputKind === 'natural' ? 'natural' : 'shorthand';
  try {
    await request.tx((trx) =>
      sql`
        insert into cg.command_outcome (tenant_id, day, command, input_kind, outcome, n)
        values (${s.tenantId}, (now() at time zone 'utc')::date, ${command}, ${kind}, ${outcome}, 1)
        on conflict (tenant_id, day, command, input_kind, outcome)
        do update set n = cg.command_outcome.n + 1`.execute(trx),
    );
  } catch (err) {
    request.log.warn({ err }, 'command outcome not counted');
  }
}

/** Where the console lists and reads each kind of record the catalog targets. */
const RECORDS: Record<
  TargetKind,
  {
    list(ref: string): string | null;
    one(id: string): string;
    label(r: ListRow): string;
    /** No version to compare at confirmation; the operation checks the record's state. */
    unversioned?: boolean;
    /** Narrows the listed rows to the ones the reference names. */
    pick?(rows: ListRow[], ref: string): ListRow[];
    /** How the window names this kind of record to a person. */
    noun?: string;
    /** What the record's changeable fields hold now, kept with the plan for undo. */
    was?(r: ListRow): Record<string, string>;
  }
> = {
  // DSP-04: a mission by its number, or by words of its place ("Willow Bend lot 41") among the
  // open missions whose location the person may see.
  mission: {
    list: (ref) =>
      /^m-?\d{1,7}$/i.test(ref.trim())
        ? `/missions?limit=10&reference=${encodeURIComponent(ref.trim())}`
        : ref.trim().length >= 3
          ? `/missions?limit=10&open=true&place=${encodeURIComponent(ref.trim())}`
          : null,
    one: (id) => `/missions/${id}`,
    label: (r) => `${str(r['reference'])} (${str(r['state']).replace('_', ' ')})`,
  },
  need: {
    list: (ref) =>
      /^[a-z0-9-]{6,12}$/i.test(ref)
        ? `/needs?limit=10&reference=${encodeURIComponent(ref)}`
        : null,
    one: (id) => `/needs/${id}`,
    label: (r) =>
      `${str(r['referenceCode'])} ${str(r['category']).replace(/_/g, ' ')} (${str(r['status'])})`,
  },
  reminder: {
    list: () => '/reminders?limit=100&open=true&mine=true',
    one: (id) => `/reminders/${id}`,
    label: (r) => `${str(r['title'])} (due ${str(r['dueAt'])})`,
    pick: (rows, ref) => {
      const want = ref.toLowerCase();
      const exact = rows.filter((r) => str(r['title']).toLowerCase() === want);
      return exact.length
        ? exact
        : rows.filter((r) => str(r['title']).toLowerCase().includes(want));
    },
  },
  // FL-07: "I'm done here" is your own open check-in; it carries no version, and ending it
  // twice is refused by the route itself.
  check_in: {
    list: () => '/check-ins?limit=5&open=true&mine=true',
    one: (id) => `/check-ins/${id}`,
    label: (r) => `checked in ${str(r['startedAt']).slice(0, 16).replace('T', ' ')} UTC`,
    unversioned: true,
    noun: 'check-in',
  },
  // CMD-16, RULE-10: "sitrep 3" or "briefing latest"; only what was issued is exported, so a
  // draft is never found here. "Latest" is the newest issued one in each event.
  official_report: {
    list: (ref) => {
      const kind = ref.split(' ')[0] ?? '';
      return /^(sitrep|briefing)$/.test(kind) ? `/official-reports?limit=200&kind=${kind}` : null;
    },
    one: (id) => `/official-reports/${id}`,
    label: (r) => {
      const tz = str(r['timeZone']) || 'UTC';
      const at = (v: unknown) =>
        new Intl.DateTimeFormat('en-US', {
          timeZone: tz,
          dateStyle: 'medium',
          timeStyle: 'short',
        }).format(new Date(str(v)));
      return `${str(r['title'])} (${str(r['state'])}), ${at(r['periodFrom'])} to ${at(r['periodTo'])}`;
    },
    pick: (rows, ref) => {
      const which = ref.split(' ')[1] ?? 'latest';
      const issued = rows.filter((r) => r['state'] === 'issued' || r['state'] === 'superseded');
      if (which !== 'latest') return issued.filter((r) => String(r['sequence']) === which);
      const newest = new Map<string, ListRow>();
      for (const r of issued) {
        const at = newest.get(str(r['eventId']));
        if (!at || Number(r['sequence']) > Number(at['sequence'])) newest.set(str(r['eventId']), r);
      }
      return [...newest.values()];
    },
    noun: 'issued report',
  },
  // AC-C08: a team by its name, call sign or key, among the teams the person may see.
  team: {
    list: () => '/teams?limit=200',
    one: (id) => `/teams/${id}`,
    label: (r) => `${str(r['name'])}${r['callsign'] ? ` (${str(r['callsign'])})` : ''}`,
    pick: (rows, ref) => {
      const want = ref.toLowerCase();
      const exact = rows.filter((r) =>
        [r['name'], r['callsign'], r['key']].some((v) => str(v).toLowerCase() === want),
      );
      return exact.length ? exact : rows.filter((r) => str(r['name']).toLowerCase().includes(want));
    },
    // A team's status changes all the time; the message names it, it does not change it.
    unversioned: true,
  },
  // CMD-14: a person on the roster by name, among the people the caller may see. The list
  // never carries contact details, so the plan and its re-check read the list, not the
  // detail route (which would decrypt and audit a contact read nobody asked for).
  personnel: {
    list: (ref) => (ref.trim() ? `/personnel?limit=10&q=${encodeURIComponent(ref.trim())}` : null),
    one: (id) => `/personnel?limit=1&id=${id}`,
    label: (r) =>
      `${str(r['name'])}${r['department'] ? `, ${str(r['department'])}` : ''} (${str(r['dutyStatus']).replace('_', ' ')}, ${str(r['availability'])})`,
    pick: (rows, ref) => {
      const want = ref.trim().toLowerCase();
      const exact = rows.filter((r) => str(r['name']).toLowerCase() === want);
      return exact.length ? exact : rows;
    },
    was: (r) => ({ dutyStatus: str(r['dutyStatus']), availability: str(r['availability']) }),
    noun: 'person on the roster',
  },
  // CMD-17: a resource by its slug, or by words in its English title; drafts included.
  resource: {
    list: (ref) => (ref.trim() ? '/resources?limit=200' : null),
    one: (id) => `/resources/${id}`,
    label: (r) => `${str(r['slug'])} (${str(r['status'])})`,
    pick: (rows, ref) => {
      const want = ref.trim().toLowerCase();
      const bySlug = rows.filter((r) => str(r['slug']) === want);
      if (bySlug.length) return bySlug;
      const title = (r: ListRow) => {
        const texts = Array.isArray(r['texts']) ? (r['texts'] as ListRow[]) : [];
        return str(texts.find((x) => x['locale'] === 'en')?.['title']).toLowerCase();
      };
      return rows.filter((r) => title(r).includes(want));
    },
    was: (r) => ({ reviewAt: str(r['reviewAt']), expiresAt: str(r['expiresAt']) }),
  },
  // CMD-18: a staff account by its exact email, or by its name; the plan names it, not the email.
  account: {
    list: (ref) => (ref.trim() ? '/accounts?limit=200' : null),
    one: (id) => `/accounts/${id}`,
    label: (r) => `${str(r['displayName'])} (${str(r['status'])})`,
    pick: (rows, ref) => {
      const want = ref.trim().toLowerCase();
      const byEmail = rows.filter((r) => str(r['email']).toLowerCase() === want);
      if (byEmail.length) return byEmail;
      const exact = rows.filter((r) => str(r['displayName']).toLowerCase() === want);
      return exact.length
        ? exact
        : rows.filter((r) => str(r['displayName']).toLowerCase().includes(want));
    },
    noun: 'account',
  },
  // CMD-18: a role by its name or key, as the Permissions screen lists them.
  role: {
    list: (ref) => (ref.trim() ? '/roles?limit=200' : null),
    one: (id) => `/roles/${id}`,
    label: (r) => str(r['name']),
    pick: (rows, ref) => {
      const want = ref.trim().toLowerCase();
      const live = rows.filter((r) => r['status'] === 'active');
      const exact = live.filter((r) =>
        [r['name'], r['key']].some((v) => str(v).toLowerCase() === want),
      );
      return exact.length ? exact : live.filter((r) => str(r['name']).toLowerCase().includes(want));
    },
    unversioned: true,
  },
  // CMD-15: a resident's report by its reference code, as the review queue lists it.
  report: {
    list: (ref) =>
      /^[a-z0-9-]{6,12}$/i.test(ref)
        ? `/reports?limit=10&reference=${encodeURIComponent(ref)}`
        : null,
    one: (id) => `/reports/${id}`,
    label: (r) =>
      `${str(r['referenceCode'])} (${str(r['reviewState']).replace(/_/g, ' ')}, ${str(r['verificationLevel']).replace(/_/g, ' ')})`,
  },
};

/** CMD-08, RULE-18: names become ids among the records the person may see; more than one asks. */
async function resolveTarget(
  request: FastifyRequest,
  kind: TargetKind,
  ref: string,
  chosen: string | undefined,
): Promise<Resolution> {
  const where = RECORDS[kind];
  const path = where.list(ref);
  if (!path) return { kind: 'none' };
  const res = await op(request, { method: 'GET', path });
  if (res.status !== 200 || !Array.isArray(res.body)) return { kind: 'none' };
  let rows = res.body as ListRow[];
  if (where.pick) rows = where.pick(rows, ref);
  if (chosen) rows = rows.filter((r) => r['id'] === chosen);
  if (rows.length === 0) return { kind: 'none' };
  if (rows.length > 1)
    return {
      kind: 'many',
      options: rows.map((r) => ({ kind, id: str(r['id']), label: where.label(r) })),
    };
  const r = rows[0]!;
  return {
    kind: 'one',
    target: {
      kind,
      id: str(r['id']),
      version: typeof r['version'] === 'number' ? r['version'] : 0,
      label: where.label(r),
      ...(where.was ? { was: where.was(r) } : {}),
    },
  };
}

/** The kinds of record a console screen can offer as context (CMD-06). */
const SCREEN_KINDS = ['mission', 'need'] as const;
type ScreenRecord = { kind: (typeof SCREEN_KINDS)[number]; id: string };

/**
 * CMD-06: "this" is the record the person has open, read again through the
 * console's own route with their credentials, so a record they may not see
 * is simply not found. Context is used only when the command says "this".
 */
async function resolveOnScreen(
  request: FastifyRequest,
  kind: TargetKind,
  context: ScreenRecord | undefined,
): Promise<Resolution> {
  if (!context || context.kind !== kind) return { kind: 'none' };
  const where = RECORDS[kind];
  const res = await op(request, { method: 'GET', path: where.one(context.id) });
  if (res.status !== 200 || !res.body || typeof res.body !== 'object') return { kind: 'none' };
  const r = res.body as ListRow;
  return {
    kind: 'one',
    target: {
      kind,
      id: str(r['id']),
      version: typeof r['version'] === 'number' ? r['version'] : 0,
      label: where.label(r),
    },
  };
}

export interface CommandDeps {
  ai?: { providerFor(tenantId: string, trx: Transaction<Database>): Promise<AiProvider | null> };
  /** CMD-38: how long the window waits before answering honestly (tests shorten it). */
  deadlineMs?: number;
}

const STILL_RUNNING =
  'Still running after 15 seconds. Nothing is lost: the result shows here when it finishes. Check the record before trying again.';

const AI_OFF =
  'Plain-language commands need the AI assistant, which is off here. Type /help for the shorthand, which always works.';

/** Puts back what redaction took out of the request (AIG-05), in the line the model wrote. */
const restore = (line: string, tokens: Record<string, string>) =>
  Object.entries(tokens).reduce((acc, [token, original]) => acc.replaceAll(token, original), line);

export const commandRoutesWith =
  (deps: CommandDeps = {}): FastifyPluginAsync =>
  async (base) => {
    const app = base.withTypeProvider<ZodTypeProvider>();
    const deadlineMs = deps.deadlineMs ?? DEADLINE_MS;

    const account = (request: FastifyRequest) => {
      const s = request.subject;
      if (s.kind !== 'account') throw errors.unauthorized();
      return s;
    };

    /**
     * CMD-38: an operation that has not answered by the deadline is reported as
     * still running, never as done or failed; it finishes in the background and
     * records its own result, which GET /commands/:id then shows.
     */
    const answerWithin = async (
      request: FastifyRequest,
      row: Row,
      work: Promise<ExecutionOut>,
    ): Promise<ExecutionOut> => {
      const r = await within(work, deadlineMs);
      if (r.done) return r.value;
      r.later.catch((err: unknown) =>
        request.log.error({ err, command: row.command }, 'command finished after its answer'),
      );
      return { ...view(row, new Date()), message: STILL_RUNNING };
    };

    /** Section 30.2: phases 1 and 2 on by default; a county turns on 3 and 4 in its configuration. */
    async function settings(request: FastifyRequest, tenantId: string) {
      return request.tx(async (trx) => {
        const cfg = await trx
          .selectFrom('cg.tenant_config')
          .select('value')
          .where('tenant_id', '=', tenantId)
          .where('key', '=', 'command.phases')
          .executeTakeFirst();
        const t = await trx
          .selectFrom('cg.tenant')
          .select('timezone')
          .where('id', '=', tenantId)
          .executeTakeFirst();
        const raw = cfg?.value;
        const phases =
          Array.isArray(raw) && raw.every((p) => typeof p === 'number')
            ? (raw as number[])
            : [...DEFAULT_PHASES];
        return { phases, timeZone: t?.timezone ?? 'UTC' };
      });
    }

    /** Whether the person's roles hold the command's action at all (the operation checks the record). */
    const holds = (request: FastifyRequest, spec: CommandSpec) => {
      const s = account(request);
      const resource = isActionKey(spec.action) ? actions[spec.action].resource : spec.action;
      return decide(s, spec.action, { type: resource, tenantId: s.tenantId }).effect === 'allow';
    };

    const holdsAction = (request: FastifyRequest, action: string) => {
      const s = account(request);
      const resource = isActionKey(action) ? actions[action].resource : action;
      return decide(s, action, { type: resource, tenantId: s.tenantId }).effect === 'allow';
    };

    const holdsBulk = (request: FastifyRequest) => {
      const s = account(request);
      return (
        decide(s, 'command.bulk', { type: 'command', tenantId: s.tenantId }).effect === 'allow'
      );
    };

    const loadOwn = (trx: Transaction<Database>, id: string, accountId: string) =>
      trx
        .selectFrom('cg.command_execution')
        .selectAll()
        .where('id', '=', id)
        .where('account_id', '=', accountId)
        .executeTakeFirst();

    /** Runs the operation and records what it answered; never claims more than it said (CMD-26). */
    async function execute(
      request: FastifyRequest,
      row: Row,
      spec: CommandSpec,
      req: OpRequest,
      extraHeaders: Record<string, string>,
    ): Promise<ExecutionOut> {
      const s = account(request);
      const started = performance.now();
      // CMD-24: an operation that did not answer is reported as such, never as done or undone.
      const res = await op(request, req, {
        'idempotency-key': row.execution_id,
        ...extraHeaders,
      }).catch((err: unknown) => {
        request.log.error({ err, command: spec.name }, 'command operation did not answer');
        return {
          status: 504,
          body: {
            code: 'no_answer',
            message: 'The operation did not answer. Check the record before trying again.',
          },
        };
      });
      const ok = res.status >= 200 && res.status < 300;
      let verified = ok
        ? row.reversal_of
          ? undoVerified(res.body)
          : spec.verify(res.body)
        : undefined;
      // AC-C07: the second step, once the first has answered; its failure leaves the first standing.
      let partly = false;
      const args = (row.plan as unknown as Plan).args;
      if (ok && verified && !row.reversal_of && spec.then?.when(args)) {
        const plan0 = row.plan as unknown as Plan;
        const second = await op(request, spec.then.request(args, plan0.target, verified), {
          'idempotency-key': derivedKey(row.execution_id, 'then'),
        }).catch(() => ({ status: 504, body: { code: 'no_answer', message: 'No answer.' } }));
        if (second.status >= 200 && second.status < 300) {
          const v2 = spec.then.verify(second.body);
          verified = {
            ...verified,
            summary: `${verified.summary} ${v2.summary}`,
            records: [...verified.records, ...v2.records],
          };
        } else {
          const why = errorOf(second.status, second.body);
          partly = true;
          verified = {
            ...verified,
            summary: `${verified.summary} Not done: ${spec.then.label} (${why.message.replace(/\.$/, '')}). What was done stands; nothing was rolled back.`,
            failures: [{ id: 'then', label: spec.then.label, ...why }],
          };
        }
      }
      const executeMs = Math.round(performance.now() - started);
      const now = new Date();
      // Lookups answer the person now; the record keeps which records, not what they said.
      const stored: StoredResult = ok
        ? {
            httpStatus: res.status,
            verified:
              spec.kind === 'lookup' && !row.reversal_of
                ? {
                    state: verified!.state,
                    summary: '',
                    records: verified!.records.map((r) => ({ kind: r.kind, id: r.id })),
                  }
                : verified!,
          }
        : { httpStatus: res.status, error: errorOf(res.status, res.body) };
      const plan = withoutFreeText(row.plan as unknown as Plan, spec);
      const done = await request.tx(async (trx) => {
        const updated = await trx
          .updateTable('cg.command_execution')
          .set({
            state: ok ? (partly ? 'partially_succeeded' : 'succeeded') : 'failed',
            result: JSON.stringify(stored),
            plan: JSON.stringify(plan),
            undo_until:
              ok && !partly && spec.reversal === 'undo_15_min' && spec.undo && !row.reversal_of
                ? new Date(now.getTime() + UNDO_MS)
                : null,
            execute_ms: executeMs,
            updated_by: s.accountId,
          })
          .where('id', '=', row.id)
          .returningAll()
          .executeTakeFirstOrThrow();
        if (ok && row.reversal_of)
          await trx
            .updateTable('cg.command_execution')
            .set({ undone_by: row.id, undo_until: null, updated_by: s.accountId })
            .where('id', '=', row.reversal_of)
            .execute();
        if (spec.kind !== 'lookup' || row.reversal_of)
          await request.audit(trx, {
            action: row.reversal_of ? 'command.undo' : 'command.execute',
            targetType: 'command_execution',
            targetId: row.id,
            targetVersion: updated.version,
            executionId: row.execution_id,
            reason: `${spec.name}@${spec.version}: ${ok ? (partly ? 'first step succeeded, second not done' : 'succeeded') : `failed (${stored.error?.code})`}${row.reason ? `; ${row.reason}` : ''}`,
          });
        return updated;
      });
      return view(done, now, verified);
    }

    /**
     * CMD-30, CMD-24: one operation per record, each with its own idempotency
     * key, so confirming twice or a retry never repeats one. Each record's
     * route checks its own state; a record that changed meanwhile is refused
     * there and named here. The execution says how many changed, never more.
     */
    async function executeBatch(
      request: FastifyRequest,
      row: Row,
      spec: CommandSpec,
      plan: Plan,
      extraHeaders: Record<string, string>,
    ): Promise<ExecutionOut> {
      const s = account(request);
      const bulk = spec.bulk!;
      const started = performance.now();
      const done: Verified['records'] = [];
      const failures: NonNullable<Verified['failures']> = [];
      for (const t of plan.batch!) {
        const res = await op(request, bulk.item(plan.args, t), {
          'idempotency-key': derivedKey(row.execution_id, t.id),
          ...extraHeaders,
        }).catch(() => ({ status: 504, body: { code: 'no_answer', message: 'No answer.' } }));
        if (res.status >= 200 && res.status < 300) {
          const n = ((res.body ?? {}) as Record<string, unknown>)['need'] as
            Record<string, unknown> | undefined;
          done.push({
            kind: t.kind,
            id: t.id,
            label: t.label,
            version: typeof n?.['version'] === 'number' ? n['version'] : undefined,
          });
        } else failures.push({ id: t.id, label: t.label, ...errorOf(res.status, res.body) });
      }
      const of = plan.batch!.length;
      const verified: Verified = {
        state: 'saved',
        summary: `${bulk.done(done.length, of)}${
          failures.length
            ? ` Not changed: ${failures
                .slice(0, 5)
                .map((f) => `${f.label} (${f.message})`)
                .join('; ')}${failures.length > 5 ? `; and ${failures.length - 5} more` : ''}.`
            : ''
        }`,
        records: done,
        ...(failures.length ? { failures } : {}),
      };
      const state =
        failures.length === 0 ? 'succeeded' : done.length ? 'partially_succeeded' : 'failed';
      const stored: StoredResult =
        state === 'failed'
          ? {
              httpStatus: 409,
              verified,
              error: { code: 'batch_failed', message: verified.summary },
            }
          : { httpStatus: 200, verified };
      const now = new Date();
      const saved = await request.tx(async (trx) => {
        const updated = await trx
          .updateTable('cg.command_execution')
          .set({
            state,
            result: JSON.stringify(stored),
            plan: JSON.stringify(withoutFreeText(plan, spec)),
            undo_until: null,
            execute_ms: Math.round(performance.now() - started),
            updated_by: s.accountId,
          })
          .where('id', '=', row.id)
          .returningAll()
          .executeTakeFirstOrThrow();
        await request.audit(trx, {
          action: 'command.execute',
          targetType: 'command_execution',
          targetId: row.id,
          targetVersion: updated.version,
          executionId: row.execution_id,
          reason: `${spec.name}@${spec.version}: ${done.length} of ${of} changed${row.reason ? `; ${row.reason}` : ''}`,
        });
        return updated;
      });
      return view(saved, now, verified);
    }

    const undoVerified = (body: unknown): Verified => {
      const b = (body ?? {}) as Record<string, unknown>;
      const rec = (b['need'] as Record<string, unknown> | undefined) ?? b;
      return {
        state: 'saved',
        summary: 'Undone.',
        records:
          typeof rec['id'] === 'string'
            ? [
                {
                  kind: 'record',
                  id: rec['id'],
                  ...(typeof rec['version'] === 'number' ? { version: rec['version'] } : {}),
                },
              ]
            : [],
      };
    };

    /**
     * Plain words to one line of shorthand through the tenant's provider, when
     * the register has the feature on (AIG-01, AIG-06, AIG-08). The model sees
     * only the redacted request and the commands this person may use here
     * (CMD-35, AIG-05); its line is then parsed and checked like typed
     * shorthand, so it can name nothing the catalog does not hold (CMD-12).
     * Off, failing or refusing, the answer points to the shorthand (AI-10).
     */
    async function interpretWords(
      request: FastifyRequest,
      executionId: string,
      text: string,
      now: Date,
      timeZone: string,
      phases: number[],
      onScreen: ScreenRecord['kind'] | null,
    ): Promise<{ answer: ExecutionOut } | { shorthand: string; aiOutputId: string }> {
      const s = account(request);
      const off = (message: string) => ({ answer: blank(executionId, 'unsupported', message) });
      const ai = deps.ai;
      if (!ai) return off(AI_OFF);
      // The provider is called outside any transaction: a slow reply holds no connection.
      const provider = await request.tx(async (trx) => {
        const feature = await trx
          .selectFrom('cg.ai_use_register')
          .where('tenant_id', '=', sql<string>`cg.current_tenant_id()`)
          .select(['enabled', 'provider'])
          .where('feature', '=', 'command.interpret')
          .executeTakeFirst();
        if (!feature?.enabled) return null;
        const p = await ai.providerFor(s.tenantId, trx);
        return p?.llm?.interpretCommand && p.info.provider === feature.provider ? p : null;
      });
      const llm = provider?.llm;
      if (!provider || !llm?.interpretCommand) return off(AI_OFF);
      const commands = CATALOG.filter((c) => phases.includes(c.phase) && holds(request, c)).map(
        (c) => ({ usage: c.usage, title: c.title }),
      );
      const { text: redacted, tokens } = redact(text);
      const call = await callAi(async () => {
        // CMD-06: the model learns only which kind of record is open, never which one.
        const r = await within(
          llm.interpretCommand!({
            text: redacted,
            commands,
            now: now.toISOString(),
            timeZone,
            onScreen,
          }),
          deadlineMs,
        );
        // CMD-38: past the deadline the reading is given up and recorded as timed out.
        if (!r.done) {
          r.later.catch(() => undefined);
          throw new AiProviderError('timeout');
        }
        return r.value;
      });
      const out = call.ok ? call.out.output : null;
      const aiOutputId = await request.tx((trx) =>
        recordAiOutput(trx, {
          tenantId: s.tenantId,
          feature: 'command.interpret',
          provider: call.ok ? call.out.provider : provider.info,
          outcome: call.ok ? (out?.injectionSuspected ? 'filtered' : 'ok') : call.outcome,
          latencyMs: call.ok ? call.out.latencyMs : call.latencyMs,
          language: out?.language ?? null,
          executionId,
        }),
      );
      if (!out)
        return off('The AI assistant did not answer. Type the shorthand instead; /help lists it.');
      if (out.injectionSuspected) return off('That request cannot be run from the command window.');
      if (!out.shorthand)
        return out.question
          ? { answer: blank(executionId, 'clarify', restore(out.question, tokens)) }
          : off('No command here fits that. Type /help for what the command window can do.');
      return { shorthand: restore(out.shorthand, tokens), aiOutputId };
    }

    // ---------------------------------------------------------------- catalog (the help)
    app.get(
      '/commands/catalog',
      {
        schema: {
          tags: ['commands'],
          response: {
            200: z.array(commandMeta.extend({ enabled: z.boolean(), allowed: z.boolean() })),
          },
        },
      },
      async (request) => {
        const s = account(request);
        await request.authorize('command.use', { type: 'command', tenantId: s.tenantId });
        const { phases } = await settings(request, s.tenantId);
        return CATALOG.map((c) => ({
          ...meta(c),
          enabled: phases.includes(c.phase),
          allowed: holds(request, c),
        }));
      },
    );

    // ---------------------------------------------------------------- history (own executions)
    app.get(
      '/commands',
      {
        schema: {
          tags: ['commands'],
          querystring: z.object({ limit: z.coerce.number().int().min(1).max(100).default(20) }),
          response: { 200: z.array(executionOut) },
        },
      },
      async (request) => {
        const s = account(request);
        await request.authorize('command.use', { type: 'command', tenantId: s.tenantId });
        const rows = await request.tx((trx) =>
          trx
            .selectFrom('cg.command_execution')
            .selectAll()
            .where('account_id', '=', s.accountId)
            .orderBy('created_at', 'desc')
            .limit(request.query.limit)
            .execute(),
        );
        const now = new Date();
        return rows.map((r) => view(r, now));
      },
    );

    // ---------------------------------------------------------------- response times (CMD-38)
    const measured = z.object({
      count: z.number().int(),
      p95Ms: z.number().nullable(),
      targetMs: z.number().int(),
      met: z.boolean().nullable(),
    });
    app.get(
      '/commands/performance',
      {
        schema: {
          tags: ['commands'],
          querystring: z.object({ days: z.coerce.number().int().min(1).max(90).default(7) }),
          response: {
            200: z.object({
              days: z.number().int(),
              deadlineMs: z.number().int(),
              shorthand: measured,
              interpretation: measured.extend({ timedOut: z.number().int() }),
              execution: measured.extend({ stillRunning: z.number().int() }),
              /** FR-C11: how often the window completed, asked, or was sent the same request again. */
              quality: z.object({
                answers: z.number().int(),
                outcomes: z.record(z.string(), z.number().int()),
                clarificationRate: z.number().nullable(),
                finished: z.number().int(),
                completionRate: z.number().nullable(),
                duplicates: z.number().int(),
                duplicateRate: z.number().nullable(),
              }),
            }),
          },
        },
      },
      async (request) => {
        const s = account(request);
        await request.authorize('ai_register.read', {
          type: 'ai_use_register',
          tenantId: s.tenantId,
        });
        const since = new Date(Date.now() - request.query.days * 86_400_000);
        const { runs, reads, counted } = await request.tx(async (trx) => ({
          counted: await trx
            .selectFrom('cg.command_outcome')
            .select(['outcome', (eb) => eb.fn.sum<string>('n').as('n')])
            .where('day', '>=', since.toISOString().slice(0, 10))
            .groupBy('outcome')
            .execute(),
          runs: await trx
            .selectFrom('cg.command_execution')
            .select(['input_kind', 'state', 'prepare_ms', 'execute_ms', 'updated_at'])
            .where('created_at', '>=', since)
            .where('reversal_of', 'is', null)
            .execute(),
          reads: await trx
            .selectFrom('cg.ai_output')
            .select(['latency_ms', 'outcome'])
            .where('feature', '=', 'command.interpret')
            .where('created_at', '>=', since)
            .execute(),
        }));
        const score = (values: number[], targetMs: number) => {
          const p = p95(values);
          return {
            count: values.length,
            p95Ms: p,
            targetMs,
            met: p === null ? null : p <= targetMs,
          };
        };
        const now = Date.now();
        const outcomes: Record<string, number> = {};
        for (const c of counted) outcomes[c.outcome] = Number(c.n);
        const duplicates = (outcomes['replayed'] ?? 0) + (outcomes['confirm_replayed'] ?? 0);
        const answers = Object.entries(outcomes)
          .filter(([k]) => k !== 'replayed' && k !== 'confirm_replayed')
          .reduce((n, [, v]) => n + v, 0);
        const rate = (part: number, whole: number) =>
          whole ? Math.round((part / whole) * 1000) / 1000 : null;
        const finished = runs.filter((r) =>
          ['succeeded', 'partially_succeeded', 'failed', 'canceled', 'stale'].includes(r.state),
        );
        return {
          days: request.query.days,
          deadlineMs,
          quality: {
            answers,
            outcomes,
            clarificationRate: rate(outcomes['clarify'] ?? 0, answers),
            finished: finished.length,
            completionRate: rate(
              finished.filter((r) => r.state === 'succeeded').length,
              finished.length,
            ),
            duplicates,
            duplicateRate: rate(duplicates, answers + duplicates),
          },
          // Shorthand and aliases are read without a model; their preparation is the target.
          shorthand: score(
            runs
              .filter((r) => r.input_kind !== 'natural' && r.prepare_ms !== null)
              .map((r) => r.prepare_ms!),
            TARGETS.shorthandMs,
          ),
          interpretation: {
            ...score(
              reads.filter((r) => r.latency_ms !== null).map((r) => Number(r.latency_ms)),
              TARGETS.interpretMs,
            ),
            timedOut: reads.filter((r) => r.outcome === 'timeout').length,
          },
          execution: {
            ...score(
              runs.filter((r) => r.execute_ms !== null).map((r) => r.execute_ms!),
              TARGETS.executeMs,
            ),
            stillRunning: runs.filter(
              (r) => r.state === 'executing' && r.updated_at.getTime() < now - deadlineMs,
            ).length,
          },
        };
      },
    );

    app.get(
      '/commands/:id',
      { schema: { tags: ['commands'], params: uuidParam, response: { 200: executionOut } } },
      async (request) => {
        const s = account(request);
        await request.authorize('command.use', { type: 'command', tenantId: s.tenantId });
        const row = await request.tx((trx) => loadOwn(trx, request.params.id, s.accountId));
        if (!row) throw errors.notFound();
        return view(row, new Date());
      },
    );

    // ---------------------------------------------------------------- aliases
    /** The live aliases this person may use: their own and the organization's. */
    const visibleAliases = async (request: FastifyRequest) => {
      const s = account(request);
      const rows = await request.tx((trx) =>
        trx
          .selectFrom('cg.command_alias')
          .select(['name', 'expansion', 'scope'])
          .where('retired_at', 'is', null)
          .where((eb) =>
            eb.or([eb('scope', '=', 'organization'), eb('account_id', '=', s.accountId)]),
          )
          .orderBy('name')
          .execute(),
      );
      return rows;
    };

    /** A personal alias wins over the organization's of the same name; words after it are kept. */
    async function findAlias(
      request: FastifyRequest,
      line: string,
    ): Promise<{ name: string; scope: AliasScope; line: string } | null> {
      const m = /^\/(\S+)(.*)$/su.exec(line.trim());
      if (!m) return null;
      const name = m[1]!.toLowerCase();
      const found = (await visibleAliases(request)).filter((a) => a.name === name);
      const a = found.find((x) => x.scope === 'personal') ?? found[0];
      return a ? { name: a.name, scope: a.scope, line: `${a.expansion}${m[2] ?? ''}` } : null;
    }

    // ---------------------------------------------------------------- personal history
    /** What the window said, in one line, for the person's own history. */
    const answerText = (e: ExecutionOut) =>
      e.status === 'awaiting_confirmation' && e.plan
        ? `Plan: ${e.plan.description}`
        : e.message || e.status.replace('_', ' ');

    /**
     * CMD-36, Section 30.2: the typed words and the answer go into the
     * person's own history, encrypted, only when the client says the device is
     * not shared; later answers on the same command join it only if it was
     * kept. The execution record is the audit either way.
     */
    async function remember(
      request: FastifyRequest,
      payload: unknown,
      typed: string | null,
      historyKey?: string,
    ): Promise<void> {
      const e = payload as Partial<ExecutionOut> | null;
      if (!e || typeof e.executionId !== 'string' || typeof e.status !== 'string') return;
      const s = account(request);
      const key = historyKey ?? e.executionId;
      const crypto = base.fieldCrypto;
      await request.tx(async (trx) => {
        if (typed === null) {
          const kept = await trx
            .selectFrom('cg.command_message')
            .select('id')
            .where('account_id', '=', s.accountId)
            .where('execution_id', '=', key)
            .executeTakeFirst();
          if (!kept) return;
        } else
          await trx
            .insertInto('cg.command_message')
            .values({
              tenant_id: s.tenantId,
              account_id: s.accountId,
              role: 'person',
              body_enc: await crypto.encrypt(s.tenantId, typed),
              execution_id: key,
            })
            .execute();
        await trx
          .insertInto('cg.command_message')
          .values({
            tenant_id: s.tenantId,
            account_id: s.accountId,
            role: 'window',
            body_enc: await crypto.encrypt(s.tenantId, answerText(e as ExecutionOut)),
            execution_id: key,
          })
          .execute();
      });
    }

    /** A legal hold on the tenant's command conversations, or on this person's, stops deletion (SEC-13). */
    const heldFor = async (trx: Transaction<Database>, accountId: string) => {
      const holds = await trx
        .selectFrom('cg.legal_hold')
        .select('scope')
        .where('released_at', 'is', null)
        .execute();
      return holds.some((h) => {
        const sc = (h.scope ?? {}) as Record<string, unknown>;
        return (
          sc['dataCategory'] === 'command_conversation' ||
          (sc['targetType'] === 'command_message' &&
            (sc['targetId'] === undefined || sc['targetId'] === accountId))
        );
      });
    };

    app.get(
      '/me/command-history',
      {
        schema: {
          tags: ['commands'],
          querystring: z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) }),
          response: {
            200: z.array(
              z.object({
                role: z.enum(['person', 'window']),
                text: z.string(),
                executionId: z.uuid().nullable(),
                createdAt: z.iso.datetime(),
              }),
            ),
          },
        },
      },
      async (request) => {
        const s = account(request);
        await request.authorize('command.use', { type: 'command', tenantId: s.tenantId });
        const rows = await request.tx((trx) =>
          trx
            .selectFrom('cg.command_message')
            .selectAll()
            .where('account_id', '=', s.accountId)
            .where('created_at', '>', new Date(Date.now() - 30 * 86_400_000))
            .orderBy('created_at', 'desc')
            // Within one request the person spoke first; the list is reversed below.
            .orderBy('role', 'desc')
            .limit(request.query.limit)
            .execute(),
        );
        return Promise.all(
          rows.reverse().map(async (r) => ({
            role: r.role,
            text: await base.fieldCrypto.decrypt(r.tenant_id, r.body_enc),
            executionId: r.execution_id,
            createdAt: iso(r.created_at)!,
          })),
        );
      },
    );

    app.delete(
      '/me/command-history',
      {
        schema: {
          tags: ['commands'],
          response: { 200: z.object({ cleared: z.number().int() }) },
        },
      },
      async (request) => {
        const s = account(request);
        await request.authorize('command.use', { type: 'command', tenantId: s.tenantId });
        return request.tx(async (trx) => {
          if (await heldFor(trx, s.accountId))
            throw new ApiError(
              409,
              'legal_hold',
              'Your command history is under a legal hold and cannot be cleared now.',
            );
          const gone = await trx
            .deleteFrom('cg.command_message')
            .where('account_id', '=', s.accountId)
            .returning('created_at')
            .execute();
          if (gone.length > 0) {
            const times = gone.map((g) => g.created_at.getTime());
            await trx
              .insertInto('cg.deletion_log')
              .values({
                tenant_id: s.tenantId,
                data_category: 'command_conversation',
                target_type: 'command_message',
                deleted_count: gone.length,
                oldest: new Date(Math.min(...times)),
                newest: new Date(Math.max(...times)),
                execution_id: request.executionId ?? randomUUID(),
              })
              .execute();
          }
          // RULE-15: clearing the conversation is recorded; the executions stay.
          await request.audit(trx, {
            action: 'command.history_cleared',
            targetType: 'account',
            targetId: s.accountId,
            reason: `${gone.length} messages`,
          });
          return { cleared: gone.length };
        });
      },
    );

    // ---------------------------------------------------------------- prepare
    app.post(
      '/commands',
      {
        preSerialization: async (request, _reply, payload) => {
          const body = request.body as { input?: string; remember?: boolean } | undefined;
          if (body?.remember === true && typeof body.input === 'string')
            await remember(request, payload, body.input);
          const out = payload as Partial<ExecutionOut> | null;
          if (out?.status)
            await countOutcome(
              request,
              out.command?.name ?? 'unknown',
              body?.input?.startsWith('/') ? 'shorthand' : 'natural',
              replays.has(request) ? 'replayed' : out.status,
            );
          return payload;
        },
        schema: {
          tags: ['commands'],
          body: z.object({
            /** CMD-25: the client's id for this request; the same id returns the same execution. */
            executionId: z.uuid(),
            input: z.string().trim().min(1).max(2000),
            eventId: z.uuid().optional(),
            /** The record chosen from a clarification (CMD-08). */
            targetId: z.uuid().optional(),
            /** The person chosen from a clarification, for a command that names one. */
            personId: z.uuid().optional(),
            /** CMD-06: the record open on the person's screen, used only for "this". */
            context: z.object({ kind: z.enum(SCREEN_KINDS), id: z.uuid() }).optional(),
            /** CMD-36: keep this exchange in the person's own history (never on a shared device). */
            remember: z.boolean().default(false),
          }),
          response: { 200: executionOut },
        },
      },
      async (request): Promise<ExecutionOut> => {
        const s = account(request);
        await request.authorize('command.use', { type: 'command', tenantId: s.tenantId });
        const b = request.body;
        const started = performance.now();
        const now = new Date();

        const prior = await request.tx((trx) =>
          trx
            .selectFrom('cg.command_execution')
            .selectAll()
            .where('execution_id', '=', b.executionId)
            .executeTakeFirst(),
        );
        if (prior) {
          if (prior.account_id !== s.accountId) throw errors.idempotencyMismatch();
          replays.add(request);
          return view(prior, now);
        }

        const { phases, timeZone } = await settings(request, s.tenantId);
        let line = b.input;
        let natural: { shorthand: string; aiOutputId: string } | null = null;
        if (!line.startsWith('/')) {
          const r = await interpretWords(
            request,
            b.executionId,
            b.input,
            now,
            timeZone,
            phases,
            b.context?.kind ?? null,
          );
          if ('answer' in r) return r.answer;
          natural = r;
          line = r.shorthand;
        }
        let parsed = parseShorthand(line, { now, timeZone });
        // CMD-04: a slash word that is no command may be the person's or the organization's alias.
        let alias: { name: string; scope: AliasScope } | null = null;
        if (!parsed.ok && parsed.error === 'unsupported' && !natural) {
          const found = await findAlias(request, line);
          if (found) {
            alias = found;
            line = found.line;
            parsed = parseShorthand(line, { now, timeZone });
          }
        }
        if (!parsed.ok) {
          if (parsed.error === 'help')
            return {
              ...blank(b.executionId, 'help', parsed.message),
              commands: CATALOG.map((c) => ({
                ...meta(c),
                enabled: phases.includes(c.phase),
                allowed: holds(request, c),
              })),
              aliases: await visibleAliases(request),
            };
          return {
            ...blank(
              b.executionId,
              parsed.error === 'usage' ? 'clarify' : 'unsupported',
              parsed.message,
            ),
            usage: parsed.usage ?? null,
          };
        }

        const spec = commandByName(parsed.command)!;
        const head = {
          ...blank(b.executionId, 'unsupported', ''),
          command: meta(spec),
          usage: spec.usage,
        };
        if (!phases.includes(spec.phase))
          return {
            ...head,
            message: `"${spec.title}" is not switched on for the command window here. Use the screen for it.`,
          };
        if (alias) {
          const may = aliasMayRun(alias.scope, spec);
          if (!may.ok)
            return { ...head, message: `/${alias.name} reads as ${line}. ${may.message}` };
        }
        if (!holds(request, spec))
          return { ...head, status: 'denied', message: 'Your role cannot do that.' };
        const args = spec.args.safeParse(parsed.args);
        if (!args.success)
          return {
            ...head,
            status: 'clarify',
            message:
              args.error.issues[0]?.message ?? 'Something in the command needs a second look.',
          };

        // CMD-30: a batch lists its records as the person may see them; one plan covers them all.
        let batch: Target[] | undefined;
        if (spec.bulk) {
          if (
            decide(s, 'command.bulk', { type: 'command', tenantId: s.tenantId }).effect !== 'allow'
          )
            return {
              ...head,
              status: 'denied',
              message: 'Your role cannot run a command over many records. Act on them one by one.',
            };
          const where = RECORDS[spec.target!];
          const found: ListRow[] = [];
          for (let offset = 0; found.length <= BATCH_MAX; offset += 200) {
            const res = await op(request, {
              method: 'GET',
              path: `${spec.bulk.list(args.data, { tenantId: s.tenantId })}&limit=200&offset=${offset}`,
            });
            const page =
              res.status === 200 && Array.isArray(res.body) ? (res.body as ListRow[]) : [];
            found.push(...page);
            if (page.length < 200) break;
          }
          if (found.length === 0)
            return { ...head, status: 'not_found', message: 'Nothing you can see matches that.' };
          if (found.length > BATCH_MAX)
            return {
              ...head,
              message: `More than ${BATCH_MAX} match. The command window changes at most ${BATCH_MAX} at once: narrow it (category:, postal:) or use the screen.`,
            };
          batch = found.map((r) => ({
            kind: spec.target!,
            id: str(r['id']),
            version: typeof r['version'] === 'number' ? r['version'] : 0,
            label: str(r['referenceCode']) || where.label(r),
          }));
        }

        let target: Target | null = null;
        if (spec.target && !spec.bulk) {
          const here = parsed.ref === ON_SCREEN;
          const r = here
            ? await resolveOnScreen(request, spec.target, b.context)
            : await resolveTarget(
                request,
                spec.target,
                parsed.ref ?? '',
                // The clients send a chosen person as personId, whichever role they play.
                spec.target === 'personnel' ? (b.targetId ?? b.personId) : b.targetId,
              );
          if (r.kind === 'none')
            return {
              ...head,
              status: 'not_found',
              message:
                spec.target === 'check_in'
                  ? 'You are not checked in, so there is nothing to check out of.'
                  : here
                    ? b.context?.kind === spec.target
                      ? `The ${spec.target} on your screen is not one you can see now.`
                      : `"This" means the ${spec.target} open on your screen, and none is. Give its ${spec.target === 'mission' ? 'number' : 'reference code'} instead.`
                    : `No ${RECORDS[spec.target].noun ?? spec.target} you can see matches "${parsed.ref ?? ''}".`,
            };
          if (r.kind === 'many')
            return {
              ...head,
              status: 'clarify',
              message: `More than one ${RECORDS[spec.target].noun ?? spec.target} matches. Which one?`,
              options: r.options,
            };
          target = r.target;
        }

        // CMD-08, CMD-14: the person a command names is found among the people this person may
        // see, by name; more than one asks which. Nothing about them is inferred.
        const planArgs = args.data as Record<string, unknown>;
        // CMD-08, CMD-15: a second record named by its reference, among those this person may see.
        if (spec.also && str(planArgs[spec.also.arg]).trim()) {
          const named = str(planArgs[spec.also.arg]).trim();
          const noun = RECORDS[spec.also.kind].noun ?? spec.also.kind;
          const other = await resolveTarget(request, spec.also.kind, named, undefined);
          if (other.kind === 'none')
            return {
              ...head,
              status: 'not_found',
              message: `No ${noun} you can see matches "${named}".`,
            };
          if (other.kind === 'many')
            return {
              ...head,
              status: 'not_found',
              message: `More than one ${noun} matches "${named}". Give its full reference code.`,
            };
          if (other.target.id === target?.id)
            return { ...head, status: 'not_found', message: `A ${noun} cannot duplicate itself.` };
          planArgs[spec.also.idArg] = other.target.id;
        }
        // AC-C07: a second step runs only for someone who may do it by hand too.
        if (spec.then?.when(planArgs) && !holdsAction(request, spec.then.action))
          return {
            ...head,
            status: 'denied',
            message: `Your role cannot do ${spec.then.label}. Leave it out, or ask someone who can.`,
          };
        if (spec.person) {
          const named = str(planArgs['person']).trim();
          const res = await op(request, {
            method: 'GET',
            path: `/personnel?limit=10&q=${encodeURIComponent(named)}`,
          });
          let found = res.status === 200 && Array.isArray(res.body) ? (res.body as ListRow[]) : [];
          const exact = found.filter((p) => str(p['name']).toLowerCase() === named.toLowerCase());
          if (exact.length) found = exact;
          if (b.personId) found = found.filter((p) => p['id'] === b.personId);
          if (found.length === 0)
            return {
              ...head,
              status: 'not_found',
              message: `Nobody on the roster you can see matches "${named}".`,
            };
          if (found.length > 1)
            return {
              ...head,
              status: 'clarify',
              message: 'More than one person matches. Which one?',
              options: found.map((p) => ({
                kind: 'personnel',
                id: str(p['id']),
                label: `${str(p['name'])}${p['department'] ? `, ${str(p['department'])}` : ''} (${str(p['availability'])})`,
              })),
            };
          planArgs['personId'] = str(found[0]!['id']);
          planArgs['person'] = str(found[0]!['name']);
        }

        // CMD-13: the one record of the target the arguments name (an open assignment of the
        // named person); none or several is answered, never guessed.
        if (spec.within && (target || !spec.target)) {
          const res = await op(request, {
            method: 'GET',
            path: spec.within.path(planArgs, target),
          });
          let found =
            res.status !== 200
              ? []
              : spec.within.rowsOf
                ? (spec.within.rowsOf(res.body) as ListRow[])
                : Array.isArray(res.body)
                  ? (res.body as ListRow[])
                  : [];
          if (spec.within.pick) found = spec.within.pick(found, planArgs);
          if (found.length !== 1)
            return {
              ...head,
              status: 'not_found',
              message: found.length ? spec.within.many(planArgs) : spec.within.none(planArgs),
            };
          planArgs[spec.within.idArg] = str(found[0]!['id']);
          if (spec.within.versionArg) planArgs[spec.within.versionArg] = found[0]!['version'];
          if (spec.within.keep) Object.assign(planArgs, spec.within.keep(found[0]!));
        }

        let eventId: string | null = null;
        if (spec.needsEvent) {
          const ev = await op(request, { method: 'GET', path: '/events?limit=100' });
          const open = (Array.isArray(ev.body) ? (ev.body as ListRow[]) : []).filter(
            (e) => e['status'] === 'active' && (!b.eventId || e['id'] === b.eventId),
          );
          if (open.length !== 1)
            return {
              ...head,
              status: 'clarify',
              message: open.length
                ? 'Which event is this about?'
                : 'There is no open event to report on.',
              options: open.map((e) => ({
                kind: 'event',
                id: str(e['id']),
                label: str(e['name']),
              })),
            };
          eventId = str(open[0]!['id']);
        }

        const plan: Plan = {
          command: spec.name,
          version: spec.version,
          args: planArgs,
          target,
          eventId,
          ...(batch ? { batch } : {}),
          ...(natural
            ? { interpretation: natural.shorthand }
            : alias
              ? { interpretation: line }
              : {}),
        };
        const hash = planHash(plan, s.tenantId, s.accountId);
        const immediate = spec.confirmation === 'none';
        const row = await request.tx(async (trx) => {
          const inserted = await trx
            .insertInto('cg.command_execution')
            .values({
              tenant_id: s.tenantId,
              account_id: s.accountId,
              execution_id: b.executionId,
              input_kind: natural ? 'natural' : alias ? 'alias' : 'shorthand',
              command: spec.name,
              command_version: spec.version,
              phase: spec.phase,
              plan: JSON.stringify(plan),
              plan_hash: hash,
              confirmation: spec.confirmation,
              reversal: spec.reversal,
              state: immediate ? 'executing' : 'awaiting_confirmation',
              prepare_ms: Math.round(performance.now() - started),
              created_by: s.accountId,
              updated_by: s.accountId,
            })
            .returningAll()
            .executeTakeFirstOrThrow();
          // AIG-01: the interpretation's record points at the plan, so what the person does with it counts.
          if (natural)
            await trx
              .updateTable('cg.ai_output')
              .set({ target_type: 'command_execution', target_id: inserted.id })
              .where('id', '=', natural.aiOutputId)
              .execute();
          return inserted;
        });
        if (!immediate) return view(row, now);
        return answerWithin(
          request,
          row,
          execute(
            request,
            row,
            spec,
            spec.request(plan.args, plan.target, { now, eventId, executionId: b.executionId }),
            {},
          ),
        );
      },
    );

    // ---------------------------------------------------------------- confirm
    app.post(
      '/commands/:id/confirm',
      {
        preSerialization: async (request, _reply, payload) => {
          await remember(request, payload, null);
          return payload;
        },
        schema: {
          tags: ['commands'],
          params: uuidParam,
          body: z.object({
            planHash: z.string().regex(/^[0-9a-f]{64}$/),
            /** CMD-30: a batch over 50 records is confirmed by typing how many. */
            count: z.number().int().min(1).optional(),
          }),
          response: { 200: executionOut },
        },
      },
      async (request) => {
        const s = account(request);
        await request.authorize('command.use', { type: 'command', tenantId: s.tenantId });
        const now = new Date();
        const row = await request.tx((trx) => loadOwn(trx, request.params.id, s.accountId));
        if (!row) throw errors.notFound();
        // AC-C06: confirming again returns what happened the first time.
        if (row.state !== 'awaiting_confirmation') {
          await countOutcome(request, row.command, row.input_kind, 'confirm_replayed');
          return view(row, now);
        }
        if (request.body.planHash !== row.plan_hash)
          throw new ApiError(
            409,
            'plan_changed',
            'This is not the plan you were shown. Prepare the command again.',
          );

        const spec = commandByName(row.command);
        const plan = row.plan as unknown as Plan;
        const { phases } = await settings(request, s.tenantId);
        const stale = async (why: string) => {
          const r = await request.tx((trx) =>
            trx
              .updateTable('cg.command_execution')
              .set({
                state: 'stale',
                plan: JSON.stringify(withoutFreeText(plan, spec)),
                result: JSON.stringify({
                  httpStatus: 409,
                  error: { code: 'plan_stale', message: why },
                }),
                updated_by: s.accountId,
              })
              .where('id', '=', row.id)
              .where('state', '=', 'awaiting_confirmation')
              .returningAll()
              .executeTakeFirst(),
          );
          throw new ApiError(409, 'plan_stale', why, { details: r ? view(r, now) : null });
        };
        if (!spec || spec.version !== row.command_version || !phases.includes(spec.phase))
          return stale('The command changed or was switched off since this was prepared.');
        if (now.getTime() - row.created_at.getTime() > PLAN_TTL_MS)
          return stale('This plan waited too long. Prepare it again.');
        // CMD-21, AC-C05: the person's roles are checked again now, and again by the operation.
        if (!holds(request, spec)) throw errors.forbidden();

        // CMD-22: the full review screen sends the confirmation and a reason.
        const consequential =
          isActionKey(spec.action) && actions[spec.action].consequential === true;
        const extra: Record<string, string> = {};
        if (spec.confirmation === 'full_review' || consequential) {
          const c = request.confirmation();
          if (!c.confirmed || !c.reason) throw errors.confirmationRequired(spec.action, spec.title);
          extra['x-confirm'] = 'true';
          extra['x-reason'] = c.reason;
        }

        // Section 30.2: up to 50 records on one confirmation; up to 500 with a second, typed one.
        if (plan.batch && plan.batch.length > BATCH_ONE_CONFIRMATION) {
          if (request.body.count !== plan.batch.length)
            // 422, not 428: the person has confirmed; what is missing is the typed count.
            throw new ApiError(
              422,
              'batch_count_required',
              `This changes ${plan.batch.length} records. Type ${plan.batch.length} to confirm.`,
              { details: { count: plan.batch.length } },
            );
        }
        if (plan.batch && (!spec.bulk || !holdsBulk(request))) throw errors.forbidden();

        // Section 30.2: no more than 30 consequential commands a minute.
        const recent = await request.tx((trx) =>
          trx
            .selectFrom('cg.command_execution')
            .select((eb) => eb.fn.countAll<string>().as('n'))
            .where('account_id', '=', s.accountId)
            .where('confirmed_at', '>', new Date(now.getTime() - 60_000))
            .executeTakeFirstOrThrow(),
        );
        if (Number(recent.n) >= RATE_PER_MINUTE)
          throw new ApiError(429, 'rate_limited', 'Too many commands in a minute. Wait a moment.', {
            retryable: true,
          });

        // CMD-09, AC-C04: the record is read again; a different version means a different plan.
        if (plan.target && !RECORDS[plan.target.kind].unversioned) {
          const cur = await op(request, {
            method: 'GET',
            path: RECORDS[plan.target.kind].one(plan.target.id),
          });
          // A list route answers with the one record, or none when it is no longer visible.
          const body: unknown = Array.isArray(cur.body) ? cur.body[0] : cur.body;
          if (cur.status === 403 || cur.status === 404 || body === undefined)
            throw errors.forbidden();
          const version = (body as { version?: unknown } | null)?.version;
          if (cur.status !== 200 || version !== plan.target.version)
            return stale(`${plan.target.label} changed since this was prepared. Prepare it again.`);
        }

        const claimed = await request.tx(async (trx) => {
          const r = await trx
            .updateTable('cg.command_execution')
            .set({
              state: 'executing',
              confirmed_by: s.accountId,
              confirmed_at: now,
              reason: extra['x-reason'] ?? null,
              updated_by: s.accountId,
            })
            .where('id', '=', row.id)
            .where('state', '=', 'awaiting_confirmation')
            .returningAll()
            .executeTakeFirst();
          // AIG-09: the person took the interpretation as shown.
          if (r && r.input_kind === 'natural')
            await recordHumanAction(
              trx,
              { type: 'command_execution', id: r.id },
              'accepted',
              s.accountId,
              now,
            );
          return r;
        });
        // Two confirmations racing: the second sees the first one's execution.
        if (!claimed) {
          await countOutcome(request, row.command, row.input_kind, 'confirm_replayed');
          const cur = await request.tx((trx) => loadOwn(trx, row.id, s.accountId));
          return view(cur!, now);
        }
        return answerWithin(
          request,
          claimed,
          plan.batch && spec.bulk
            ? executeBatch(request, claimed, spec, plan, extra)
            : execute(
                request,
                claimed,
                spec,
                spec.request(plan.args, plan.target, {
                  now,
                  eventId: plan.eventId,
                  executionId: row.execution_id,
                }),
                extra,
              ),
        );
      },
    );

    // ---------------------------------------------------------------- cancel
    app.post(
      '/commands/:id/cancel',
      {
        preSerialization: async (request, _reply, payload) => {
          await remember(request, payload, null);
          return payload;
        },
        schema: { tags: ['commands'], params: uuidParam, response: { 200: executionOut } },
      },
      async (request) => {
        const s = account(request);
        await request.authorize('command.use', { type: 'command', tenantId: s.tenantId });
        const now = new Date();
        const row = await request.tx(async (trx) => {
          const cur = await loadOwn(trx, request.params.id, s.accountId);
          if (!cur) throw errors.notFound();
          if (cur.state === 'canceled') return cur;
          // CMD-27: cancelling stops only what has not run; it never reverses what has.
          if (cur.state !== 'awaiting_confirmation')
            throw new ApiError(
              409,
              'already_run',
              cur.state === 'executing'
                ? 'It is already running; cancelling cannot stop it. The result shows when it finishes.'
                : 'It already ran. Cancelling does not reverse it; use undo where offered, or the screen.',
            );
          const updated = await trx
            .updateTable('cg.command_execution')
            .set({
              state: 'canceled',
              plan: JSON.stringify(
                withoutFreeText(cur.plan as unknown as Plan, commandByName(cur.command)),
              ),
              updated_by: s.accountId,
            })
            .where('id', '=', cur.id)
            .where('state', '=', 'awaiting_confirmation')
            .returningAll()
            .executeTakeFirstOrThrow();
          // AIG-09: a cancelled interpretation counts as rejected.
          if (cur.input_kind === 'natural')
            await recordHumanAction(
              trx,
              { type: 'command_execution', id: cur.id },
              'rejected',
              s.accountId,
              now,
            );
          await request.audit(trx, {
            action: 'command.cancel',
            targetType: 'command_execution',
            targetId: cur.id,
            targetVersion: updated.version,
            reason: cur.command,
          });
          return updated;
        });
        return view(row, now);
      },
    );

    // ---------------------------------------------------------------- undo
    app.post(
      '/commands/:id/undo',
      {
        preSerialization: async (request, _reply, payload) => {
          // The undo joins the history of the command it reverses.
          const e = payload as Partial<ExecutionOut> | null;
          if (!e?.reversalOf) return payload;
          const original = await request.tx((trx) =>
            trx
              .selectFrom('cg.command_execution')
              .select('execution_id')
              .where('id', '=', e.reversalOf!)
              .executeTakeFirst(),
          );
          if (original) await remember(request, payload, null, original.execution_id);
          return payload;
        },
        schema: {
          tags: ['commands'],
          params: uuidParam,
          body: z.object({ executionId: z.uuid() }),
          response: { 200: executionOut },
        },
      },
      async (request) => {
        const s = account(request);
        await request.authorize('command.use', { type: 'command', tenantId: s.tenantId });
        const now = new Date();
        const { prior, original } = await request.tx(async (trx) => ({
          prior: await trx
            .selectFrom('cg.command_execution')
            .selectAll()
            .where('execution_id', '=', request.body.executionId)
            .executeTakeFirst(),
          original: await loadOwn(trx, request.params.id, s.accountId),
        }));
        if (prior) {
          if (prior.account_id !== s.accountId || prior.reversal_of !== request.params.id)
            throw errors.idempotencyMismatch();
          return view(prior, now);
        }
        if (!original) throw errors.notFound();
        const spec = commandByName(original.command);
        const stored = original.result as StoredResult | null;
        // CMD-28, AC-C08: only what can safely be reversed, within its window, once.
        if (
          !spec?.undo ||
          original.state !== 'succeeded' ||
          original.undone_by ||
          !original.undo_until ||
          original.undo_until.getTime() <= now.getTime() ||
          !stored?.verified
        )
          throw new ApiError(
            409,
            'undo_unavailable',
            spec?.undoUnavailable ??
              (spec?.reversal === 'compensating'
                ? 'This cannot be undone here. Correct it on the screen with a new entry; the original stays in the history.'
                : 'Undo is no longer available for this.'),
          );
        const plan = original.plan as unknown as Plan;
        const req = spec.undo(plan.args, plan.target, stored.verified);
        const undoPlan = {
          ...plan,
          undoOf: original.id,
          request: { method: req.method, path: req.path },
        };
        const row = await request.tx((trx) =>
          trx
            .insertInto('cg.command_execution')
            .values({
              tenant_id: s.tenantId,
              account_id: s.accountId,
              execution_id: request.body.executionId,
              input_kind: original.input_kind,
              command: original.command,
              command_version: original.command_version,
              phase: original.phase,
              plan: JSON.stringify(undoPlan),
              plan_hash: createHash('sha256').update(canonical(undoPlan)).digest('hex'),
              confirmation: 'one_tap',
              reversal: 'none',
              state: 'executing',
              confirmed_by: s.accountId,
              confirmed_at: now,
              reversal_of: original.id,
              created_by: s.accountId,
              updated_by: s.accountId,
            })
            .returningAll()
            .executeTakeFirstOrThrow(),
        );
        return execute(request, row, spec, req, {});
      },
    );
  };

export const commandRoutes = commandRoutesWith();
