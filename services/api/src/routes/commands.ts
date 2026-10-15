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
import { createHash } from 'node:crypto';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type { Selectable, Transaction } from 'kysely';
import { z } from 'zod';
import { actions, decide, isActionKey } from '@cg/authz';
import type { CommandExecutionTable, Database } from '@cg/db';
import {
  CATALOG,
  commandByName,
  DEFAULT_PHASES,
  type CommandSpec,
  type OpRequest,
  type Target,
  type TargetKind,
  type Verified,
} from '../commands/catalog.ts';
import { parseShorthand } from '../commands/parse.ts';
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
});
type ExecutionOut = z.infer<typeof executionOut>;

interface Plan {
  command: string;
  version: number;
  args: Record<string, unknown>;
  target: Target | null;
  eventId: string | null;
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
        : spec
          ? spec.describe(plan.args, plan.target)
          : row.command,
      args: plan.args ?? {},
      target: plan.target ?? null,
      eventId: plan.eventId ?? null,
    },
    planHash: row.state === 'awaiting_confirmation' ? row.plan_hash : null,
    result: verified
      ? { state: verified.state, summary: verified.summary ?? null, records: verified.records }
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

/** Where the console lists and reads each kind of record the catalog targets. */
const RECORDS: Record<
  TargetKind,
  { list(ref: string): string | null; one(id: string): string; label(r: ListRow): string }
> = {
  mission: {
    list: (ref) => `/missions?limit=10&reference=${encodeURIComponent(ref)}`,
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
  if (kind === 'reminder') {
    const want = ref.toLowerCase();
    const exact = rows.filter((r) => str(r['title']).toLowerCase() === want);
    rows = exact.length ? exact : rows.filter((r) => str(r['title']).toLowerCase().includes(want));
  }
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
    target: { kind, id: str(r['id']), version: Number(r['version']), label: where.label(r) },
  };
}

export const commandRoutes: FastifyPluginAsync = async (base) => {
  const app = base.withTypeProvider<ZodTypeProvider>();

  const account = (request: FastifyRequest) => {
    const s = request.subject;
    if (s.kind !== 'account') throw errors.unauthorized();
    return s;
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
    const now = new Date();
    const verified = ok
      ? row.reversal_of
        ? undoVerified(res.body)
        : spec.verify(res.body)
      : undefined;
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
          state: ok ? 'succeeded' : 'failed',
          result: JSON.stringify(stored),
          plan: JSON.stringify(plan),
          undo_until:
            ok && spec.reversal === 'undo_15_min' && spec.undo && !row.reversal_of
              ? new Date(now.getTime() + UNDO_MS)
              : null,
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
          reason: `${spec.name}@${spec.version}: ${ok ? 'succeeded' : `failed (${stored.error?.code})`}${row.reason ? `; ${row.reason}` : ''}`,
        });
      return updated;
    });
    return view(done, now, verified);
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

  // ---------------------------------------------------------------- prepare
  app.post(
    '/commands',
    {
      schema: {
        tags: ['commands'],
        body: z.object({
          /** CMD-25: the client's id for this request; the same id returns the same execution. */
          executionId: z.uuid(),
          input: z.string().trim().min(1).max(2000),
          eventId: z.uuid().optional(),
          /** The record chosen from a clarification (CMD-08). */
          targetId: z.uuid().optional(),
        }),
        response: { 200: executionOut },
      },
    },
    async (request): Promise<ExecutionOut> => {
      const s = account(request);
      await request.authorize('command.use', { type: 'command', tenantId: s.tenantId });
      const b = request.body;
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
        return view(prior, now);
      }

      const { phases, timeZone } = await settings(request, s.tenantId);
      if (!b.input.startsWith('/'))
        return blank(
          b.executionId,
          'unsupported',
          'Plain-language commands need the AI assistant. Type /help for the shorthand, which always works.',
        );
      const parsed = parseShorthand(b.input, { now, timeZone });
      if (!parsed.ok) {
        if (parsed.error === 'help')
          return {
            ...blank(b.executionId, 'help', parsed.message),
            commands: CATALOG.map((c) => ({
              ...meta(c),
              enabled: phases.includes(c.phase),
              allowed: holds(request, c),
            })),
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
      if (!holds(request, spec))
        return { ...head, status: 'denied', message: 'Your role cannot do that.' };
      const args = spec.args.safeParse(parsed.args);
      if (!args.success)
        return {
          ...head,
          status: 'clarify',
          message: args.error.issues[0]?.message ?? 'Something in the command needs a second look.',
        };

      let target: Target | null = null;
      if (spec.target) {
        const r = await resolveTarget(request, spec.target, parsed.ref ?? '', b.targetId);
        if (r.kind === 'none')
          return {
            ...head,
            status: 'not_found',
            message: `No ${spec.target} you can see matches "${parsed.ref ?? ''}".`,
          };
        if (r.kind === 'many')
          return {
            ...head,
            status: 'clarify',
            message: `More than one ${spec.target} matches. Which one?`,
            options: r.options,
          };
        target = r.target;
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
            options: open.map((e) => ({ kind: 'event', id: str(e['id']), label: str(e['name']) })),
          };
        eventId = str(open[0]!['id']);
      }

      const plan: Plan = {
        command: spec.name,
        version: spec.version,
        args: args.data,
        target,
        eventId,
      };
      const hash = planHash(plan, s.tenantId, s.accountId);
      const immediate = spec.confirmation === 'none';
      const row = await request.tx((trx) =>
        trx
          .insertInto('cg.command_execution')
          .values({
            tenant_id: s.tenantId,
            account_id: s.accountId,
            execution_id: b.executionId,
            input_kind: 'shorthand',
            command: spec.name,
            command_version: spec.version,
            phase: spec.phase,
            plan: JSON.stringify(plan),
            plan_hash: hash,
            confirmation: spec.confirmation,
            reversal: spec.reversal,
            state: immediate ? 'executing' : 'awaiting_confirmation',
            created_by: s.accountId,
            updated_by: s.accountId,
          })
          .returningAll()
          .executeTakeFirstOrThrow(),
      );
      if (!immediate) return view(row, now);
      return execute(
        request,
        row,
        spec,
        spec.request(plan.args, plan.target, { now, eventId, executionId: b.executionId }),
        {},
      );
    },
  );

  // ---------------------------------------------------------------- confirm
  app.post(
    '/commands/:id/confirm',
    {
      schema: {
        tags: ['commands'],
        params: uuidParam,
        body: z.object({ planHash: z.string().regex(/^[0-9a-f]{64}$/) }),
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
      if (row.state !== 'awaiting_confirmation') return view(row, now);
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
      const consequential = isActionKey(spec.action) && actions[spec.action].consequential === true;
      const extra: Record<string, string> = {};
      if (spec.confirmation === 'full_review' || consequential) {
        const c = request.confirmation();
        if (!c.confirmed || !c.reason) throw errors.confirmationRequired(spec.action, spec.title);
        extra['x-confirm'] = 'true';
        extra['x-reason'] = c.reason;
      }

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
      if (plan.target) {
        const cur = await op(request, {
          method: 'GET',
          path: RECORDS[plan.target.kind].one(plan.target.id),
        });
        if (cur.status === 403 || cur.status === 404) throw errors.forbidden();
        const version = (cur.body as { version?: unknown } | null)?.version;
        if (cur.status !== 200 || version !== plan.target.version)
          return stale(`${plan.target.label} changed since this was prepared. Prepare it again.`);
      }

      const claimed = await request.tx((trx) =>
        trx
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
          .executeTakeFirst(),
      );
      // Two confirmations racing: the second sees the first one's execution.
      if (!claimed) {
        const cur = await request.tx((trx) => loadOwn(trx, row.id, s.accountId));
        return view(cur!, now);
      }
      return execute(
        request,
        claimed,
        spec,
        spec.request(plan.args, plan.target, {
          now,
          eventId: plan.eventId,
          executionId: row.execution_id,
        }),
        extra,
      );
    },
  );

  // ---------------------------------------------------------------- cancel
  app.post(
    '/commands/:id/cancel',
    { schema: { tags: ['commands'], params: uuidParam, response: { 200: executionOut } } },
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
          spec?.reversal === 'compensating'
            ? 'This cannot be undone here. Correct it on the screen with a new entry; the original stays in the history.'
            : 'Undo is no longer available for this.',
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
