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
  people: 'people',
  personnel: 'people',
  personas: 'people',
  personal: 'people',
  reports: 'reports',
  reportes: 'reports',
  report: 'report',
  reporte: 'report',
  message: 'message',
  mensaje: 'message',
  resources: 'resources',
  recursos: 'resources',
  contacts: 'contacts',
  contactos: 'contacts',
  log: 'log',
  registrar: 'log',
  anotar: 'log',
  checkout: 'checkout',
  check_out: 'checkout',
  salida: 'checkout',
  export: 'export',
  exportar: 'export',
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
  priority: 'priority',
  prioridad: 'priority',
  assign: 'assign',
  asignar: 'assign',
  close: 'close',
  cerrar: 'close',
  reopen: 'reopen',
  reabrir: 'reopen',
};

const PRIORITIES: Record<string, string> = {
  low: 'low',
  baja: 'low',
  normal: 'normal',
  high: 'high',
  alta: 'high',
  urgent: 'urgent',
  urgente: 'urgent',
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
const KEYS = new Set([
  'reason',
  'text',
  'note',
  'role',
  'to',
  'minutes',
  'title',
  'skill',
  'department',
  'agency',
  'disposition',
  'category',
  'categoria',
  'postal',
  'from',
  'desde',
  'hasta',
  'request',
  'solicitud',
  'evidence',
  'evidencia',
]);

/** CMD-14: availability as the roster records it. */
const AVAILABILITY: Record<string, string> = {
  available: 'available',
  disponible: 'available',
  disponibles: 'available',
  assigned: 'assigned',
  asignado: 'assigned',
  asignados: 'assigned',
  unavailable: 'unavailable',
  no_disponible: 'unavailable',
};

/** CMD-15: the review queue's states and filters. */
const REPORT_FILTERS: Record<string, [string, string | boolean]> = {
  new: ['state', 'submitted'],
  submitted: ['state', 'submitted'],
  nuevos: ['state', 'submitted'],
  under_review: ['state', 'under_review'],
  en_revision: ['state', 'under_review'],
  needs_information: ['state', 'needs_information'],
  needs_info: ['state', 'needs_information'],
  falta_informacion: ['state', 'needs_information'],
  approved: ['state', 'approved'],
  aprobados: ['state', 'approved'],
  rejected: ['state', 'rejected'],
  rechazados: ['state', 'rejected'],
  duplicate: ['state', 'duplicate'],
  duplicados: ['state', 'duplicate'],
  flagged: ['flagged', true],
  marcados: ['flagged', true],
  danger: ['danger', true],
  peligro: ['danger', true],
};

/** FL-07: what a frontline worker counts, in English and Spanish, singular or plural. */
const SERVICE_KINDS: Record<string, string> = {
  meal: 'meal',
  meals: 'meal',
  comida: 'meal',
  comidas: 'meal',
  water: 'water_case',
  waters: 'water_case',
  water_case: 'water_case',
  water_cases: 'water_case',
  agua: 'water_case',
  aguas: 'water_case',
  tarp: 'tarp',
  tarps: 'tarp',
  lona: 'tarp',
  lonas: 'tarp',
  cot: 'cot',
  cots: 'cot',
  catre: 'cot',
  catres: 'cot',
  ride: 'ride',
  rides: 'ride',
  viaje: 'ride',
  viajes: 'ride',
  people: 'person_served',
  person: 'person_served',
  persons: 'person_served',
  personas: 'person_served',
  voucher: 'voucher',
  vouchers: 'voucher',
  vale: 'voucher',
  vales: 'voucher',
  pet_food: 'pet_food',
};

const NUMBER_WORDS: Record<string, number> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  uno: 1,
  una: 1,
  dos: 2,
  tres: 3,
  cuatro: 4,
  cinco: 5,
  seis: 6,
  siete: 7,
  ocho: 8,
  nueve: 9,
  diez: 10,
};

/** CMD-17: the kinds of partner contact. */
const CONTACT_TYPES: Record<string, string> = {
  operations: 'operations',
  operaciones: 'operations',
  '24h': 'twenty_four_hour',
  twenty_four_hour: 'twenty_four_hour',
  '24_horas': 'twenty_four_hour',
  backup: 'backup',
  respaldo: 'backup',
  media: 'media',
  medios: 'media',
  prensa: 'media',
  liaison: 'liaison',
  enlace: 'liaison',
};

/** CMD-13: the kinds of mission a draft can be, in English and Spanish. */
const MISSION_KINDS: Record<string, string> = {
  welfare_check: 'welfare_check',
  welfare: 'welfare_check',
  bienestar: 'welfare_check',
  verification_route: 'verification_route',
  verification: 'verification_route',
  verificacion: 'verification_route',
  cleanup_work_order: 'cleanup_work_order',
  cleanup: 'cleanup_work_order',
  limpieza: 'cleanup_work_order',
  delivery: 'delivery',
  entrega: 'delivery',
  outreach_sweep: 'outreach_sweep',
  outreach: 'outreach_sweep',
  alcance: 'outreach_sweep',
  site_staffing: 'site_staffing',
  staffing: 'site_staffing',
  personal_de_sitio: 'site_staffing',
  search: 'search',
  busqueda: 'search',
  road_clearance: 'road_clearance',
  road: 'road_clearance',
  despeje: 'road_clearance',
  traffic_control: 'traffic_control',
  traffic: 'traffic_control',
  trafico: 'traffic_control',
  debris: 'debris',
  escombros: 'debris',
  other: 'other',
  otra: 'other',
  otro: 'other',
};
const NEW_WORDS = new Set(['new', 'nueva', 'nuevo']);
const MISSION_DRAFT_USAGE = `/mission new <${[...new Set(Object.values(MISSION_KINDS))].join('|')}> <what is needed>`;

/** CMD-15: what a reviewer does to one report, in English and Spanish. */
const REPORT_ACTIONS: Record<string, 'claim' | 'approve' | 'reject' | 'ask'> = {
  review: 'claim',
  revisar: 'claim',
  claim: 'claim',
  tomar: 'claim',
  approve: 'approve',
  aprobar: 'approve',
  reject: 'reject',
  rechazar: 'reject',
  ask: 'ask',
  info: 'ask',
  preguntar: 'ask',
  pedir_informacion: 'ask',
};
const REPORT_USAGE =
  '/report <reference code> review | approve <why> | reject <why> | ask <question>';

/** CMD-16: the exports the window can prepare. */
const EXPORT_IDA = new Set(['ida', 'ida_package', 'paquete_ida']);
const EXPORT_RECORDS = new Set(['records', 'public_records', 'registros', 'registros_publicos']);
const REPORT_KINDS: Record<string, string> = {
  sitrep: 'sitrep',
  informe: 'sitrep',
  briefing: 'briefing',
  sesion_informativa: 'briefing',
};
const LATEST = new Set(['latest', 'last', 'ultimo', 'ultima']);
/** SEC-13: the kinds of record a public-records release can hold, in either language. */
const RECORD_TYPE_WORDS: Record<string, string> = {
  reports: 'reports',
  reportes: 'reports',
  needs: 'needs',
  necesidades: 'needs',
  missions: 'missions',
  misiones: 'missions',
  timeline: 'mission_timeline',
  mission_timeline: 'mission_timeline',
  cronologia: 'mission_timeline',
  sites: 'sites',
  sitios: 'sites',
  official_reports: 'official_reports',
  informes: 'official_reports',
  field_messages: 'field_messages',
  mensajes: 'field_messages',
  comms: 'comms_log',
  comms_log: 'comms_log',
  comunicaciones: 'comms_log',
};
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

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

/**
 * CMD-06: "this" stands for the record open on the person's screen, which the
 * window shows and sends as context; the server resolves it under the
 * person's own permissions. Nothing on the screen is used unless named.
 */
export const ON_SCREEN = '@screen';
const THIS_WORDS = new Set(['this', 'esta', 'este', 'esto']);
const onScreen = (ref: string | undefined) =>
  ref !== undefined && THIS_WORDS.has(norm(ref)) ? ON_SCREEN : ref;

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
      // CMD-13, Section 30.2 phase 1: a mission draft; nothing is dispatched.
      if (NEW_WORDS.has(norm(words[0] ?? ''))) {
        const kind = MISSION_KINDS[norm(words[1] ?? '')];
        if (!kind) return usage('What kind of mission?', MISSION_DRAFT_USAGE);
        const summary = (pairs['text'] ?? words.slice(2).join(' ')).trim();
        if (summary.length < 3) return usage('What is needed?', MISSION_DRAFT_USAGE);
        return ok('mission.draft', { kind, summary });
      }
      const [first, sub, ...rest] = words;
      const ref = onScreen(first);
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
      if (s === 'priority') {
        const p = PRIORITIES[norm(rest[0] ?? '')];
        if (!p)
          return usage(
            'Which priority? low, normal, high or urgent.',
            '/mission <number> priority <low|normal|high|urgent>',
          );
        return ok('mission.priority', { priority: p }, ref, 'mission');
      }
      if (s === 'assign') {
        const person = rest.join(' ').trim();
        if (!person) return usage('Assign whom?', '/mission <number> assign <person>');
        return ok('mission.assign', { person }, ref, 'mission');
      }
      if (s === 'close') {
        const d = pairs['disposition'] ? norm(pairs['disposition']) : undefined;
        return ok('mission.close', d ? { disposition: d } : {}, ref, 'mission');
      }
      if (s === 'reopen') return ok('mission.reopen', {}, ref, 'mission');
      return usage(
        `"${sub}" is not something the command window can do to a mission yet.`,
        '/mission <number> [status <state> | note <text> | priority <level> | assign <person> | close | reopen]',
      );
    }

    case 'needs': {
      const args: Record<string, unknown> = {};
      // CMD-30: "/needs open category:food claim" claims every open need the filter names.
      const at = words.findIndex((w) => ['claim', 'release'].includes(SUBVERBS[norm(w)] ?? ''));
      if (at >= 0) {
        const verb = SUBVERBS[norm(words[at]!)] as 'claim' | 'release';
        const want = verb === 'claim' ? 'open' : 'claimed';
        const u =
          verb === 'claim'
            ? '/needs open [category:<category>] [postal:<code>] claim [note]'
            : '/needs claimed [category:<category>] [postal:<code>] release [note]';
        for (const w of words.slice(0, at)) {
          const f = NEED_FILTERS[norm(w)];
          if (f !== want)
            return usage(
              verb === 'claim'
                ? `Only open needs can be claimed; "${w}" does not fit before claim.`
                : `Only needs your organization holds can be released; "${w}" does not fit before release.`,
              u,
            );
        }
        const category = pairs['category'] ?? pairs['categoria'];
        const note = (pairs['note'] ?? words.slice(at + 1).join(' ')).trim();
        return ok(verb === 'claim' ? 'needs.claim_many' : 'needs.release_many', {
          ...(category ? { category: norm(category) } : {}),
          ...(pairs['postal'] ? { postal: pairs['postal'] } : {}),
          ...(note ? { note } : {}),
        });
      }
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
      const [first, sub, ...rest] = words;
      const ref = onScreen(first);
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

    case 'people': {
      const args: Record<string, unknown> = {};
      const name: string[] = [];
      for (const w of words) {
        const n = norm(w);
        if (AVAILABILITY[n]) args['availability'] = AVAILABILITY[n];
        else if (n === 'on_duty' || n === 'de_turno' || n === 'en_turno') args['onDuty'] = true;
        else name.push(w);
      }
      if (pairs['skill']) args['skill'] = pairs['skill'];
      if (pairs['department']) args['department'] = pairs['department'];
      if (name.length) args['name'] = name.join(' ');
      return ok('people.find', args);
    }

    case 'reports': {
      const args: Record<string, unknown> = {};
      for (const w of words) {
        const f = REPORT_FILTERS[norm(w)];
        if (f) args[f[0]] = f[1];
        // A reference code has a digit, so a mistyped filter word is not taken for one.
        else if (/^(?=.*\d)[a-z0-9-]{6,12}$/iu.test(w)) args['reference'] = w;
        else
          return usage(
            `"${w}" is not a reports filter.`,
            '/reports [submitted|under_review|needs_information|flagged|danger|<reference code>]',
          );
      }
      return ok('reports.find', args);
    }

    // AC-C08, Section 30.2 phase 4: a message to a team's phones; the first word (or to:) names the team.
    case 'message': {
      const to = (pairs['to'] ?? words[0] ?? '').trim();
      const text = (pairs['text'] ?? (pairs['to'] ? words : words.slice(1)).join(' ')).trim();
      if (!to || !text)
        return usage('Which team, and what should it say?', '/message <team> <text>');
      return ok('team.message', { text }, to, 'team');
    }

    // CMD-15: take a report into review, decide it, or ask the resident; never two at once.
    case 'report': {
      const [ref, sub, ...rest] = words;
      if (!ref) return usage('Which report? Give its reference code.', REPORT_USAGE);
      if (!sub) return ok('reports.find', { reference: ref });
      const act = REPORT_ACTIONS[norm(sub)];
      if (!act) return usage(`"${sub}" is not something a reviewer does here.`, REPORT_USAGE);
      const text = (pairs['reason'] ?? pairs['text'] ?? rest.join(' ')).trim();
      const evidence = (pairs['evidence'] ?? pairs['evidencia'] ?? '')
        .split(',')
        .map((e) => e.trim())
        .filter(Boolean);
      if (act === 'claim') return ok('report.claim', {}, ref, 'report');
      if (act === 'ask') {
        if (!text) return usage('What should the resident be asked?', REPORT_USAGE);
        return ok('report.ask', { message: text }, ref, 'report');
      }
      if (text.length < 3) return usage('Say why, for the record.', REPORT_USAGE);
      return ok(
        act === 'approve' ? 'report.approve' : 'report.reject',
        { reason: text, evidenceRefs: evidence },
        ref,
        'report',
      );
    }

    case 'resources': {
      const category = words.map(norm).join('_');
      return ok('resources.find', category ? { category } : {});
    }

    case 'log': {
      let count: number | null = null;
      let kind: string | null = null;
      for (const w of words) {
        const n = norm(w);
        if (/^\d{1,4}$/.test(n)) count = Number(n);
        else if (NUMBER_WORDS[n]) count = NUMBER_WORDS[n]!;
        else if (SERVICE_KINDS[n]) kind = SERVICE_KINDS[n]!;
      }
      if (!count || !kind)
        return usage(
          'How many of what? For example "/log 2 meals".',
          '/log <count> <meals|water|tarps|cots|rides|people|vouchers|pet_food>',
        );
      return ok('service.log', { count, kind });
    }

    case 'checkout':
      return ok('shift.end', {}, '', 'check_in');

    case 'contacts': {
      const args: Record<string, unknown> = {};
      const agency: string[] = [];
      for (const w of words) {
        const t = CONTACT_TYPES[norm(w)];
        if (t) args['type'] = t;
        else agency.push(w);
      }
      const a = (pairs['agency'] ?? agency.join(' ')).trim();
      if (a) args['agency'] = a;
      return ok('contacts.find', args);
    }

    // CMD-16: every export states its scope and its period; nothing is exported unasked.
    case 'export': {
      const what = norm(words[0] ?? '');
      const rest = words.slice(1);
      if (EXPORT_IDA.has(what)) return ok('ida.export', {});
      const reportKind = REPORT_KINDS[what];
      if (reportKind) {
        let format = 'pdf';
        let which = 'latest';
        for (const w of rest) {
          const n = norm(w);
          if (n === 'pdf' || n === 'csv') format = n;
          else if (/^\d{1,4}$/.test(n)) which = String(Number(n));
          else if (!LATEST.has(n))
            return usage(`"${w}" is not a report number or format.`, EXPORT_USAGE);
        }
        return ok('report.export', { format }, `${reportKind} ${which}`, 'official_report');
      }
      if (EXPORT_RECORDS.has(what)) {
        const reference = (pairs['request'] ?? pairs['solicitud'] ?? rest[0] ?? '').trim();
        const kinds = pairs['request'] || pairs['solicitud'] ? rest : rest.slice(1);
        if (!reference) return usage('Which records request does this answer?', EXPORT_USAGE);
        const recordTypes: string[] = [];
        for (const w of kinds) {
          const t = RECORD_TYPE_WORDS[norm(w).replace(/,$/, '')];
          if (!t)
            return usage(`"${w}" is not a kind of record that can be released.`, EXPORT_USAGE);
          if (!recordTypes.includes(t)) recordTypes.push(t);
        }
        if (recordTypes.length === 0)
          return usage('Which kinds of record? For example: reports needs missions.', EXPORT_USAGE);
        const from = pairs['from'] ?? pairs['desde'];
        const to = pairs['to'] ?? pairs['hasta'];
        if ((from && !ISO_DATE.test(from)) || (to && !ISO_DATE.test(to)))
          return usage('Give dates as YYYY-MM-DD.', EXPORT_USAGE);
        return ok('public_records.export', {
          requestReference: reference,
          recordTypes,
          ...(from ? { from } : {}),
          ...(to ? { to } : {}),
        });
      }
      return usage('Export what?', EXPORT_USAGE);
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

const EXPORT_USAGE =
  '/export ida | /export sitrep|briefing [number|latest] [pdf|csv] | /export records <request> <kinds> [from:YYYY-MM-DD] [to:YYYY-MM-DD]';

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
