/**
 * The command catalog and the shorthand parser (layer-7 task B; ADR-0044;
 * CMD-05, CMD-10, CMD-12, CMD-22, CMD-28, Section 30.2): every command names
 * a real action and an honest reversal; shorthand reads English and Spanish
 * verbs without a model; times are read on the organization's clock and
 * "tomorrow morning" is not guessed.
 */
import { describe, expect, it } from 'vitest';
import { COMMAND_EVAL_CATALOG } from '@cg/ai';
import { actions } from '@cg/authz';
import { checkAlias } from '../src/commands/aliases.ts';
import { CATALOG, DEFAULT_PHASES } from '../src/commands/catalog.ts';
import {
  ON_SCREEN,
  parseMinutes,
  parseShorthand,
  resolveWhen,
  tokenize,
  wallClock,
} from '../src/commands/parse.ts';

const ctx = { now: new Date('2026-10-15T15:00:00Z'), timeZone: 'America/Chicago' };
const parse = (s: string) => parseShorthand(s, ctx);

describe('the command catalog', () => {
  it('CMD-12: every command names an action in the authorization catalog, once', () => {
    const names = CATALOG.map((c) => c.name);
    expect(new Set(names).size).toBe(names.length);
    for (const c of CATALOG) expect(Object.keys(actions), c.name).toContain(c.action);
  });

  it('CMD-22, Section 30.2: lookups and drafts need no confirmation; every change does', () => {
    for (const c of CATALOG)
      expect(c.confirmation === 'none', c.name).toBe(c.kind === 'lookup' || c.kind === 'draft');
  });

  it('CMD-28: only a command that can really be reversed offers undo, and it has an undo operation', () => {
    for (const c of CATALOG) {
      expect(c.reversal === 'undo_15_min', c.name).toBe(typeof c.undo === 'function');
      if (c.kind !== 'change') expect(c.reversal, c.name).toBe('none');
    }
  });

  it('AIG-08: the evaluation set asks the model about exactly the commands the catalog holds', () => {
    expect(COMMAND_EVAL_CATALOG).toEqual(CATALOG.map((c) => ({ usage: c.usage, title: c.title })));
  });

  it('Section 30.2: phases 1 and 2 are on by default; status changes are phase 3', () => {
    expect([...DEFAULT_PHASES]).toEqual([1, 2]);
    expect(CATALOG.find((c) => c.name === 'mission.status')?.phase).toBe(3);
    expect(CATALOG.find((c) => c.name === 'person.status')?.phase).toBe(3);
    expect(CATALOG.filter((c) => c.phase === 1).every((c) => c.kind !== 'change')).toBe(true);
  });

  it('a command that targets a record sends the version it planned against when the operation checks one', () => {
    const t = {
      kind: 'reminder' as const,
      id: '00000000-0000-4000-8000-000000000001',
      version: 4,
      label: 'x',
    };
    const snooze = CATALOG.find((c) => c.name === 'reminder.snooze')!;
    expect(
      snooze.request({ minutes: 30 }, t, { now: ctx.now, eventId: null, executionId: 'e' }),
    ).toMatchObject({
      method: 'POST',
      path: `/reminders/${t.id}/snooze`,
      version: 4,
    });
  });
});

describe('shorthand', () => {
  it('keeps quoted text together, straight or curly quotes', () => {
    expect(tokenize('mission M-00001 note "two words" reason:“a b”')).toEqual([
      'mission',
      'M-00001',
      'note',
      'two words',
      'reason:a b',
    ]);
  });

  it('Section 30.2: verb, object, id, then key:value pairs', () => {
    expect(parse('/mission M-00012 status on_scene reason:"crew arrived"')).toEqual({
      ok: true,
      command: 'mission.status',
      args: { to: 'on_scene', reason: 'crew arrived' },
      ref: 'M-00012',
      refKind: 'mission',
    });
    expect(parse('/MISSION M-00012')).toMatchObject({ ok: true, command: 'mission.show' });
  });

  it('Spanish verbs and values are built-in synonyms, accents optional', () => {
    expect(parse('/misión M-00012 estado en_camino')).toMatchObject({
      command: 'mission.status',
      args: { to: 'en_route' },
    });
    expect(parse('/misiones sin asignar')).toMatchObject({
      command: 'missions.find',
      args: { unassigned: true },
    });
    expect(parse('/necesidad ABC123 reclamar')).toMatchObject({
      command: 'need.claim',
      ref: 'ABC123',
    });
    expect(parse('/ayuda')).toMatchObject({ ok: false, error: 'help' });
  });

  it('CMD-14, CMD-15, CMD-17: people, reports, resources and contacts, in English and Spanish', () => {
    expect(parse('/people available skill:chainsaw department:"Public Works" Ana')).toEqual({
      ok: true,
      command: 'people.find',
      args: {
        availability: 'available',
        skill: 'chainsaw',
        department: 'Public Works',
        name: 'Ana',
      },
      ref: null,
      refKind: null,
    });
    expect(parse('/personas disponibles de_turno skill:motosierra')).toMatchObject({
      command: 'people.find',
      args: { availability: 'available', onDuty: true, skill: 'motosierra' },
    });
    // CMD-14: the longest status phrase at the end wins; "assigned" comes from assignments only.
    expect(parse('/person Dana Ruiz unavailable')).toEqual({
      ok: true,
      command: 'person.status',
      args: { set: 'unavailable' },
      ref: 'Dana Ruiz',
      refKind: 'personnel',
    });
    expect(parse('/persona Dana Ruiz no disponible')).toMatchObject({
      args: { set: 'unavailable' },
      ref: 'Dana Ruiz',
    });
    expect(parse('/persona Dana fuera de turno')).toMatchObject({
      args: { set: 'off_duty' },
      ref: 'Dana',
    });
    expect(parse('/person Dana on duty')).toMatchObject({ args: { set: 'on_duty' }, ref: 'Dana' });
    expect(parse('/person Dana assigned')).toMatchObject({ ok: false, error: 'usage' });
    expect(parse('/person available')).toMatchObject({ ok: false, error: 'usage' });
    expect(parse('/reports new flagged')).toMatchObject({
      command: 'reports.find',
      args: { state: 'submitted', flagged: true },
    });
    expect(parse('/reportes peligro WW-7K3Q9')).toMatchObject({
      command: 'reports.find',
      args: { danger: true, reference: 'WW-7K3Q9' },
    });
    expect(parse('/reports everything')).toMatchObject({ ok: false, error: 'usage' });
    expect(parse('/recursos vivienda')).toMatchObject({
      command: 'resources.find',
      args: { category: 'vivienda' },
    });
    expect(parse('/contacts 24h Red Cross')).toMatchObject({
      command: 'contacts.find',
      args: { type: 'twenty_four_hour', agency: 'Red Cross' },
    });
    expect(parse('/contactos prensa')).toMatchObject({
      command: 'contacts.find',
      args: { type: 'media' },
    });
  });

  it('CMD-13, AC-C01: priority, assignment, closure and reopening of a mission', () => {
    expect(parse('/mission M-00012 priority urgent')).toEqual({
      ok: true,
      command: 'mission.priority',
      args: { priority: 'urgent' },
      ref: 'M-00012',
      refKind: 'mission',
    });
    expect(parse('/misión M-00012 prioridad alta')).toMatchObject({ args: { priority: 'high' } });
    expect(parse('/mission M-00012 priority whenever')).toMatchObject({ error: 'usage' });
    expect(parse('/mission M-00012 assign Ana Ruiz')).toMatchObject({
      command: 'mission.assign',
      args: { person: 'Ana Ruiz' },
    });
    expect(parse('/mision M-00012 asignar')).toMatchObject({ error: 'usage' });
    expect(parse('/mission M-00012 close disposition:referred')).toMatchObject({
      command: 'mission.close',
      args: { disposition: 'referred' },
    });
    expect(parse('/mission M-00012 cerrar')).toMatchObject({ command: 'mission.close', args: {} });
    expect(parse('/mission M-00012 reabrir')).toMatchObject({ command: 'mission.reopen' });
  });

  it('CMD-06: "this" (or esta, este) stands for the record on the screen; any other word is a reference', () => {
    expect(parse('/mission this status on_scene')).toMatchObject({
      ok: true,
      command: 'mission.status',
      ref: ON_SCREEN,
      refKind: 'mission',
    });
    expect(parse('/necesidad esta reclamar')).toMatchObject({
      command: 'need.claim',
      ref: ON_SCREEN,
    });
    expect(parse('/mission 20261009-003')).toMatchObject({ ref: '20261009-003' });
  });

  it('CMD-30: "/needs open … claim" and "/needs claimed … release" are batches over a filter; a status that cannot be claimed or released is refused', () => {
    expect(
      parse('/needs open category:food_water postal:63003 claim note:"Exercise: pantry"'),
    ).toMatchObject({
      ok: true,
      command: 'needs.claim_many',
      args: { category: 'food_water', postal: '63003', note: 'Exercise: pantry' },
    });
    expect(parse('/necesidades reclamadas categoria:agua liberar')).toMatchObject({
      command: 'needs.release_many',
      args: { category: 'agua' },
    });
    expect(parse('/needs claimed claim')).toMatchObject({ ok: false, error: 'usage' });
    expect(parse('/needs open')).toMatchObject({ command: 'needs.find' });
  });

  it('FL-07: "log two meals" and "I\'m done here" as shorthand, in English and Spanish', () => {
    expect(parse('/log 2 meals')).toEqual({
      ok: true,
      command: 'service.log',
      args: { count: 2, kind: 'meal' },
      ref: null,
      refKind: null,
    });
    expect(parse('/registrar tres comidas')).toMatchObject({ args: { count: 3, kind: 'meal' } });
    expect(parse('/log water 12')).toMatchObject({ args: { count: 12, kind: 'water_case' } });
    expect(parse('/log some meals')).toMatchObject({ ok: false, error: 'usage' });
    expect(parse('/checkout')).toMatchObject({ command: 'shift.end', refKind: 'check_in' });
    expect(parse('/salida')).toMatchObject({ command: 'shift.end' });
  });

  it('free text after a sub-verb keeps its colons; only known keys are pairs', () => {
    expect(parse('/mission M-1 note Crew says: road closed at Elm')).toMatchObject({
      command: 'mission.note',
      args: { text: 'Crew says: road closed at Elm' },
    });
  });

  it('CMD-12: unknown verbs and actions are unsupported, never guessed', () => {
    expect(parse('/delete everything')).toMatchObject({ ok: false, error: 'unsupported' });
    expect(parse('/mission M-1 delete')).toMatchObject({ ok: false, error: 'usage' });
    expect(parse('claim the food need')).toMatchObject({ ok: false, error: 'unsupported' });
  });

  it('CMD-13, AC-C08: "/mission new" drafts a mission of a known kind; "/message" names a team and the words', () => {
    expect(parse('/mission new welfare Check on the family at 14 Elm')).toMatchObject({
      command: 'mission.draft',
      args: { kind: 'welfare_check', summary: 'Check on the family at 14 Elm' },
    });
    expect(parse('/mision nueva escombros Calle 5 bloqueada')).toMatchObject({
      command: 'mission.draft',
      args: { kind: 'debris', summary: 'Calle 5 bloqueada' },
    });
    expect(parse('/mission new rescue now')).toMatchObject({ ok: false, error: 'usage' });
    expect(parse('/mission new delivery')).toMatchObject({ ok: false, error: 'usage' });
    expect(parse('/message FX-1 Water is safe to drink')).toMatchObject({
      command: 'team.message',
      ref: 'FX-1',
      refKind: 'team',
      args: { text: 'Water is safe to drink' },
    });
    expect(parse('/mensaje to:"Field Exercise Team" El agua es potable')).toMatchObject({
      command: 'team.message',
      ref: 'Field Exercise Team',
      args: { text: 'El agua es potable' },
    });
    expect(parse('/message FX-1')).toMatchObject({ ok: false, error: 'usage' });
    const added = CATALOG.filter((c) => ['mission.draft', 'team.message'].includes(c.name));
    expect(added.map((c) => [c.name, c.phase, c.confirmation, c.kind])).toEqual([
      ['mission.draft', 1, 'none', 'draft'],
      ['team.message', 4, 'full_review', 'change'],
    ]);
  });

  it('CMD-15: a reviewer takes a report into review, decides it with a reason and evidence, or asks the resident', () => {
    expect(parse('/report AB12CD review')).toMatchObject({
      command: 'report.claim',
      ref: 'AB12CD',
      refKind: 'report',
    });
    expect(parse('/report AB12CD approve photos match evidence:photo-1,visit-2')).toMatchObject({
      command: 'report.approve',
      args: { reason: 'photos match', evidenceRefs: ['photo-1', 'visit-2'] },
    });
    expect(parse('/reporte AB12CD rechazar reason:"not in the county"')).toMatchObject({
      command: 'report.reject',
      args: { reason: 'not in the county', evidenceRefs: [] },
    });
    expect(parse('/report AB12CD ask How many people live there?')).toMatchObject({
      command: 'report.ask',
      args: { message: 'How many people live there?' },
    });
    expect(parse('/report AB12CD')).toMatchObject({
      command: 'reports.find',
      args: { reference: 'AB12CD' },
    });
    expect(parse('/report AB12CD approve')).toMatchObject({ ok: false, error: 'usage' });
    expect(parse('/report AB12CD ask')).toMatchObject({ ok: false, error: 'usage' });
    expect(parse('/report AB12CD delete')).toMatchObject({ ok: false, error: 'usage' });
    const review = CATALOG.filter((c) => c.name.startsWith('report.'));
    expect(review.map((c) => [c.name, c.phase, c.confirmation])).toEqual([
      ['report.claim', 3, 'one_tap'],
      ['report.approve', 4, 'full_review'],
      ['report.reject', 4, 'full_review'],
      ['report.ask', 4, 'full_review'],
      ['report.export', 3, 'one_tap'],
    ]);
  });

  it('CMD-16: exports name their scope; a report by number or the latest, PDF unless CSV is asked; a release names its request, kinds and dates', () => {
    expect(parse('/export ida')).toMatchObject({ command: 'ida.export', args: {} });
    expect(parse('/export sitrep 3 csv')).toMatchObject({
      command: 'report.export',
      ref: 'sitrep 3',
      refKind: 'official_report',
      args: { format: 'csv' },
    });
    expect(parse('/exportar informe ultimo')).toMatchObject({
      command: 'report.export',
      ref: 'sitrep latest',
      args: { format: 'pdf' },
    });
    expect(parse('/export briefing')).toMatchObject({ ref: 'briefing latest' });
    expect(parse('/export sitrep draft')).toMatchObject({ ok: false, error: 'usage' });
    expect(
      parse('/export records PRR-114 reports needs, missions from:2026-10-01 to:2026-10-15'),
    ).toMatchObject({
      command: 'public_records.export',
      args: {
        requestReference: 'PRR-114',
        recordTypes: ['reports', 'needs', 'missions'],
        from: '2026-10-01',
        to: '2026-10-15',
      },
    });
    expect(parse('/exportar registros solicitud:"PRR 7" reportes cronologia')).toMatchObject({
      args: { requestReference: 'PRR 7', recordTypes: ['reports', 'mission_timeline'] },
    });
    expect(parse('/export records PRR-1')).toMatchObject({ ok: false, error: 'usage' });
    expect(parse('/export records PRR-1 residents')).toMatchObject({ ok: false, error: 'usage' });
    expect(parse('/export records PRR-1 needs from:10/01/2026')).toMatchObject({
      ok: false,
      error: 'usage',
    });
    expect(parse('/export everything')).toMatchObject({ ok: false, error: 'usage' });
    // Exports are confirmed and never in phase 1; a records release is phase 4 with a full review.
    const exports = CATALOG.filter((c) => /export/.test(c.name));
    expect(exports.map((c) => [c.name, c.phase, c.confirmation])).toEqual([
      ['ida.export', 3, 'one_tap'],
      ['report.export', 3, 'one_tap'],
      ['public_records.export', 4, 'full_review'],
    ]);
  });

  it('CMD-16: a reminder is done only with what was done', () => {
    expect(parse('/reminder generator done')).toMatchObject({ ok: false, error: 'usage' });
    expect(parse('/reminder check generator done refuelled')).toMatchObject({
      command: 'reminder.complete',
      ref: 'check generator',
      args: { note: 'refuelled' },
    });
    expect(parse('/recordatorio generador posponer 1h30m')).toMatchObject({
      command: 'reminder.snooze',
      args: { minutes: 90 },
    });
  });
});

describe('CMD-10: times on the organization clock', () => {
  it('reads durations', () => {
    expect(parseMinutes('30')).toBe(30);
    expect(parseMinutes('45m')).toBe(45);
    expect(parseMinutes('2h')).toBe(120);
    expect(parseMinutes('1h30m')).toBe(90);
    expect(parseMinutes('soon')).toBeNull();
  });

  it('"in 30m" and "en 2 horas" count from now', () => {
    expect(resolveWhen(['in', '30m'], ctx)?.at.toISOString()).toBe('2026-10-15T15:30:00.000Z');
    expect(resolveWhen(['en', '2', 'horas'], ctx)).toMatchObject({ used: 3 });
  });

  it('"14:30" is today in Chicago, or tomorrow once past; "tomorrow 08:00" is the next day', () => {
    // 15:00Z is 10:00 in Chicago (CDT).
    expect(resolveWhen(['14:30'], ctx)?.at.toISOString()).toBe('2026-10-15T19:30:00.000Z');
    expect(resolveWhen(['09:00'], ctx)?.at.toISOString()).toBe('2026-10-16T14:00:00.000Z');
    expect(resolveWhen(['mañana', '08:00'], ctx)?.at.toISOString()).toBe(
      '2026-10-16T13:00:00.000Z',
    );
  });

  it('crosses a daylight-saving change on the right hour', () => {
    // 2026-11-01 is the fall-back day in the United States: 08:00 is CST (UTC-6).
    const before = new Date('2026-10-31T15:00:00Z');
    expect(wallClock(before, 'America/Chicago', 8, 0, 1).toISOString()).toBe(
      '2026-11-01T14:00:00.000Z',
    );
  });

  it('does not guess "tomorrow morning"', () => {
    expect(resolveWhen(['tomorrow', 'morning'], ctx)).toBeNull();
    expect(parse('/remind tomorrow morning check the shelter')).toMatchObject({
      ok: false,
      error: 'usage',
    });
  });
});

describe('CMD-04: alias rules', () => {
  it('a personal alias may look things up or draft, never change anything', () => {
    expect(checkAlias('personal', 'food', '/needs open', ctx)).toMatchObject({ ok: true });
    expect(checkAlias('personal', 'brief', '/sitrep 6', ctx)).toMatchObject({ ok: true });
    expect(checkAlias('personal', 'grab', '/need ABC123 claim', ctx)).toMatchObject({
      ok: false,
      code: 'scope',
    });
  });

  it('an organization alias may name a change; neither scope may shadow a command, in either language', () => {
    expect(checkAlias('organization', 'grab', '/need ABC123 claim', ctx)).toMatchObject({
      ok: true,
    });
    expect(checkAlias('personal', 'needs', '/needs open', ctx)).toMatchObject({ code: 'reserved' });
    expect(checkAlias('organization', 'ayuda', '/needs open', ctx)).toMatchObject({
      code: 'reserved',
    });
  });

  it('names are short lower-case words; expansions must be commands', () => {
    expect(checkAlias('personal', 'Food!', '/needs open', ctx)).toMatchObject({ code: 'name' });
    expect(checkAlias('personal', 'x', '/needs open', ctx)).toMatchObject({ code: 'name' });
    expect(checkAlias('personal', 'oops', '/delete everything', ctx)).toMatchObject({
      code: 'expansion',
    });
  });
});
