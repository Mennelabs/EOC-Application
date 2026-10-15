/**
 * Shorthand for the command window (layer-7 task B; Section 30.2, CMD-03,
 * CMD-05, CMD-10, ADR-0044). Slash verb, object, identifier, then key:value
 * pairs: `/mission 20261009-003 status on_scene reason:"crew arrived"`.
 * Case-insensitive, Spanish verbs as built-in synonyms, no model: shorthand
 * works with AI switched off. The parser only names a catalogued command, its
 * arguments and the reference to resolve; the server resolves the reference
 * among the records the person may see and checks everything again.
 */
import type { TargetKind } from './catalog.ts';

export type Parsed =
  | {
      ok: true;
      command: string;
      args: Record<string, unknown>;
      /** The identifier or title to resolve, when the command acts on one record. */
      ref: string | null;
      refKind: TargetKind | null;
    }
  | { ok: false; error: 'help' | 'unsupported' | 'usage'; message: string; usage?: string };

/** Quoted strings stay together; straight and curly quotes both work. */
export function tokenize(input: string): string[] {
  const out: string[] = [];
  const re = /(\w+:)?(?:"([^"]*)"|“([^”]*)”|'([^']*)')|(\S+)/gu;
  for (const m of input.matchAll(re)) {
    if (m[5] !== undefined) out.push(m[5]);
    else out.push(`${m[1] ?? ''}${m[2] ?? m[3] ?? m[4] ?? ''}`);
  }
  return out;
}

const norm = (s: string) =>
  s.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '').replace(/-/g, '_');

/** Verb synonyms, English and Spanish, accents optional. */
const VERBS: Record<string, string> = {
  missions: 'missions',
  misiones: 'missions',
  mission: 'mission',
  mision: 'mission',
  needs: 'needs',
  necesidades: 'needs',
  need: 'need',
  necesidad: 'need',
  reminders: 'reminders',
  recordatorios: 'reminders',
  reminder: 'reminder',
  recordatorio: 'reminder',
  remind: 'remind',
  recordar: 'remind',
  recuerdame: 'remind',
  sitrep: 'sitrep',
  informe: 'sitrep',
  help: 'help',
  ayuda: 'help',
};

/** CMD-04: names an alias may never take, in either language (accents removed). */
export const RESERVED_NAMES: ReadonlySet<string> = new Set(Object.keys(VERBS));

const SUBVERBS: Record<string, string> = {
  status: 'status',
  estado: 'status',
  note: 'note',
  nota: 'note',
  claim: 'claim',
  reclamar: 'claim',
  tomar: 'claim',
  release: 'release',
  liberar: 'release',
  soltar: 'release',
  snooze: 'snooze',
  posponer: 'snooze',
  done: 'done',
  complete: 'done',
  hecho: 'done',
  completar: 'done',
};

const MISSION_STATES: Record<string, string> = {
  open: 'open',
  abierta: 'open',
  abierto: 'open',
  en_route: 'en_route',
  enroute: 'en_route',
  en_camino: 'en_route',
  on_scene: 'on_scene',
  onscene: 'on_scene',
  en_sitio: 'on_scene',
  en_escena: 'on_scene',
  en_lugar: 'on_scene',
  cleared: 'cleared',
  despejada: 'cleared',
  despejado: 'cleared',
  terminada: 'cleared',
};

const NEED_FILTERS: Record<string, string> = {
  open: 'open',
  abiertas: 'open',
  claimed: 'claimed',
  reclamadas: 'claimed',
  in_progress: 'in_progress',
  en_curso: 'in_progress',
  met: 'met',
  atendidas: 'met',
};

/** The keys a key:value pair may use; anything else with a colon stays part of the text. */
const KEYS = new Set(['reason', 'text', 'note', 'role', 'to', 'minutes', 'title']);

/** Separates key:value pairs from the words around them. */
function split(tokens: string[]): { words: string[]; pairs: Record<string, string> } {
  const words: string[] = [];
  const pairs: Record<string, string> = {};
  for (const t of tokens) {
    const m = /^([a-z_]{2,}):(.*)$/iu.exec(t);
    if (m && KEYS.has(norm(m[1]!))) pairs[norm(m[1]!)] = m[2] ?? '';
    else words.push(t);
  }
  return { words, pairs };
}

const usage = (message: string, u: string): Parsed => ({
  ok: false,
  error: 'usage',
  message,
  usage: u,
});

export interface ParseContext {
  now: Date;
  /** The organization's time zone (CMD-10). */
  timeZone: string;
}

/** Parses one shorthand line. Input that does not start with "/" is not shorthand. */
export function parseShorthand(input: string, ctx: ParseContext): Parsed {
  const text = input.trim();
  if (!text.startsWith('/'))
    return { ok: false, error: 'unsupported', message: 'Shorthand starts with "/".' };
  const tokens = tokenize(text.slice(1));
  const verb = VERBS[norm(tokens[0] ?? '')];
  if (!verb)
    return {
      ok: false,
      error: 'unsupported',
      message: `"/${tokens[0] ?? ''}" is not a command here. Type /help for the list.`,
    };
  const { words, pairs } = split(tokens.slice(1));
  const ok = (
    command: string,
    args: Record<string, unknown>,
    ref: string | null = null,
    refKind: TargetKind | null = null,
  ): Parsed => ({ ok: true, command, args, ref, refKind });

  switch (verb) {
    case 'help':
      return { ok: false, error: 'help', message: 'The commands you can use here.' };

    case 'missions': {
      const args: Record<string, unknown> = {};
      const filters = words.map(norm).join(' ').replace('sin asignar', 'sin_asignar').split(' ');
      for (const w of filters.filter(Boolean)) {
        if (w === 'unassigned' || w === 'sin_asignar') args['unassigned'] = true;
        else if (w === 'open' || w === 'abiertas') args['open'] = true;
        else if (MISSION_STATES[w]) args['state'] = MISSION_STATES[w];
        else return usage(`"${w}" is not a mission filter.`, '/missions [open|unassigned|<state>]');
      }
      return ok('missions.find', args);
    }

    case 'mission': {
      const [ref, sub, ...rest] = words;
      if (!ref) return usage('Which mission? Give its number.', '/mission <number>');
      if (!sub) return ok('mission.show', {}, ref, 'mission');
      const s = SUBVERBS[norm(sub)];
      if (s === 'status') {
        const to = MISSION_STATES[norm(rest.join('_') || pairs['to'] || '')];
        if (!to)
          return usage(
            'Which status? open, en_route, on_scene or cleared.',
            '/mission <number> status <open|en_route|on_scene|cleared> [reason:"…"]',
          );
        return ok(
          'mission.status',
          { to, ...(pairs['reason'] ? { reason: pairs['reason'] } : {}) },
          ref,
          'mission',
        );
      }
      if (s === 'note') {
        const body = (pairs['text'] ?? rest.join(' ')).trim();
        if (!body) return usage('What should the note say?', '/mission <number> note <text>');
        const role = pairs['role'];
        return ok('mission.note', { text: body, ...(role ? { role } : {}) }, ref, 'mission');
      }
      return usage(
        `"${sub}" is not something the command window can do to a mission yet.`,
        '/mission <number> [status <state> | note <text>]',
      );
    }

    case 'needs': {
      const args: Record<string, unknown> = {};
      for (const w of words) {
        const f = NEED_FILTERS[norm(w)];
        if (f) args['status'] = f;
        else if (/^[a-z0-9-]{6,12}$/iu.test(w)) args['reference'] = w;
        else
          return usage(`"${w}" is not a needs filter.`, '/needs [open|claimed|<reference code>]');
      }
      return ok('needs.find', args);
    }

    case 'need': {
      const [ref, sub, ...rest] = words;
      if (!ref || !sub)
        return usage(
          'Which need, and claim or release?',
          '/need <reference code> claim|release [note]',
        );
      const s = SUBVERBS[norm(sub)];
      const note = (pairs['note'] ?? rest.join(' ')).trim();
      const args = note ? { note } : {};
      if (s === 'claim') return ok('need.claim', args, ref, 'need');
      if (s === 'release') return ok('need.release', args, ref, 'need');
      return usage(
        `"${sub}" is not something the command window can do to a need.`,
        '/need <reference code> claim|release [note]',
      );
    }

    case 'reminders':
      return ok('reminders.list', {});

    case 'reminder': {
      // The title may be several words; the sub-verb is the first word that is one.
      const at = words.findIndex(
        (w) => SUBVERBS[norm(w)] === 'snooze' || SUBVERBS[norm(w)] === 'done',
      );
      if (at < 1)
        return usage(
          'Which reminder, and snooze or done?',
          '/reminder "<title>" snooze <minutes> | /reminder "<title>" done <what was done>',
        );
      const ref = words.slice(0, at).join(' ');
      const s = SUBVERBS[norm(words[at]!)];
      const rest = words.slice(at + 1);
      if (s === 'snooze') {
        const minutes = parseMinutes(rest.join(' ') || pairs['minutes'] || '');
        if (!minutes)
          return usage(
            'For how long? For example 30m or 2h.',
            '/reminder "<title>" snooze <30m|2h>',
          );
        return ok('reminder.snooze', { minutes }, ref, 'reminder');
      }
      const note = (pairs['note'] ?? rest.join(' ')).trim();
      if (!note) return usage('Say what was done.', '/reminder "<title>" done <what was done>');
      return ok('reminder.complete', { note }, ref, 'reminder');
    }

    case 'remind': {
      const when = resolveWhen(words, ctx);
      if (!when)
        return usage(
          'When? For example "in 30m", "in 2h", "14:30" or "tomorrow 08:00".',
          '/remind <in 30m | in 2h | HH:MM | tomorrow HH:MM> <what>',
        );
      const title = (pairs['title'] ?? words.slice(when.used).join(' ')).trim();
      if (!title) return usage('What should the reminder say?', '/remind <when> <what>');
      return ok('reminder.create', { title, dueAt: when.at.toISOString() });
    }

    case 'sitrep': {
      const h = words[0] ? parseHours(words[0]) : 12;
      if (!h) return usage('For how many hours back?', '/sitrep [hours, e.g. 12]');
      return ok('sitrep.draft', { hours: h });
    }
  }
  return { ok: false, error: 'unsupported', message: 'Not a command here.' };
}

/** 30, 30m, 30min, 2h, 1h30m. */
export function parseMinutes(s: string): number | null {
  const t = s.trim().toLowerCase().replace(/\s+/g, '');
  if (/^\d+$/.test(t)) return Number(t) || null;
  const m = /^(?:(\d+)h)?(?:(\d+)(?:m|min|mins|minutes|minutos)?)?$/.exec(
    t.replace(/hours?|horas?/, 'h'),
  );
  if (!m || (!m[1] && !m[2])) return null;
  const n = Number(m[1] ?? 0) * 60 + Number(m[2] ?? 0);
  return n > 0 ? n : null;
}

function parseHours(s: string): number | null {
  const m = /^(\d{1,3})h?$/i.exec(s.trim());
  return m ? Number(m[1]) : null;
}

/** The offset of a time zone from UTC at an instant, in milliseconds. */
function zoneOffset(at: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(at);
  const v = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const wall = Date.UTC(v('year'), v('month') - 1, v('day'), v('hour'), v('minute'), v('second'));
  return wall - Math.floor(at.getTime() / 1000) * 1000;
}

/** A wall-clock time on the organization's calendar, today or a number of days on. */
export function wallClock(now: Date, timeZone: string, hh: number, mm: number, daysOn = 0): Date {
  const local = new Date(now.getTime() + zoneOffset(now, timeZone));
  const guess = Date.UTC(
    local.getUTCFullYear(),
    local.getUTCMonth(),
    local.getUTCDate() + daysOn,
    hh,
    mm,
  );
  // Twice, so a daylight-saving change between now and then lands on the right hour.
  let at = guess - zoneOffset(new Date(guess), timeZone);
  at = guess - zoneOffset(new Date(at), timeZone);
  return new Date(at);
}

/**
 * CMD-10: "in 30m", "in 2h", "en 30m", "14:30" (today, or tomorrow once past),
 * "tomorrow 08:00", "mañana 08:00", in the organization's time zone. "Tomorrow
 * morning" without a time is not guessed; the person is asked.
 */
export function resolveWhen(words: string[], ctx: ParseContext): { at: Date; used: number } | null {
  const w = words.map(norm);
  if ((w[0] === 'in' || w[0] === 'en') && w[1]) {
    // "in 30m" or "in 30 min" / "in 2 hours".
    const two = w[2] && /^(m|min|mins|minutes|minutos|h|hours?|horas?)$/.test(w[2]);
    const minutes = parseMinutes(two ? `${w[1]}${w[2]}` : w[1]);
    if (!minutes) return null;
    return { at: new Date(ctx.now.getTime() + minutes * 60_000), used: two ? 3 : 2 };
  }
  const tomorrow = w[0] === 'tomorrow' || w[0] === 'manana';
  const clock = /^(\d{1,2}):(\d{2})$/.exec(words[tomorrow ? 1 : 0] ?? '');
  if (!clock) return null;
  const hh = Number(clock[1]);
  const mm = Number(clock[2]);
  if (hh > 23 || mm > 59) return null;
  let at = wallClock(ctx.now, ctx.timeZone, hh, mm, tomorrow ? 1 : 0);
  if (!tomorrow && at.getTime() <= ctx.now.getTime())
    at = wallClock(ctx.now, ctx.timeZone, hh, mm, 1);
  return { at, used: tomorrow ? 2 : 1 };
}
