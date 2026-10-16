/**
 * The frontline role modules (layer-4 task J; FLD-01, FLD-07, FLD-14,
 * EQ-07): every label and option has English and Spanish; no module that
 * holds children's or health details takes photos; the command body carries
 * only what the form asked for, numbers where the server wants numbers; and
 * a form cannot be saved without its required answers.
 */
import { describe, expect, it } from 'vitest';
import { allLabels, commandBody, missing, moduleByKind, MODULES } from '../src/records.ts';

describe('field role modules', () => {
  it('has every label in English and Spanish, with no exclamation marks', () => {
    for (const l of allLabels()) {
      expect(l.en.trim().length, JSON.stringify(l)).toBeGreaterThan(0);
      expect(l.es.trim().length, JSON.stringify(l)).toBeGreaterThan(0);
      expect(`${l.en} ${l.es}`).not.toMatch(/!|¡/);
    }
  });

  it('keeps photos off the private records and matches each module to its write action', () => {
    for (const k of ['health_note', 'shelter_incident', 'right_of_entry', 'interpreter_request'])
      expect(moduleByKind.get(k)?.photos, k).toBe(false);
    for (const m of MODULES)
      expect(m.action.endsWith('.write') || m.action === 'interpreter.request').toBe(true);
    expect(new Set(MODULES.map((m) => m.kind)).size).toBe(MODULES.length);
  });

  it('builds the command body and refuses a form without its required answers', () => {
    const debris = moduleByKind.get('debris_ticket')!;
    expect(missing(debris, { loadPercent: '100' })).toEqual(['ticketNumber', 'debrisType']);
    const body = commandBody(debris, {
      ticketNumber: ' T-1001 ',
      debrisType: 'vegetative',
      loadPercent: '75',
      truckCapacityCy: 20,
      truckId: '',
    });
    expect(body).toEqual({
      ticketNumber: 'T-1001',
      debrisType: 'vegetative',
      loadPercent: 75,
      truckCapacityCy: 20,
    });
    const roe = moduleByKind.get('right_of_entry')!;
    expect(missing(roe, { signerRole: 'owner', signerName: 'A', scope: 'Tarp the roof' })).toEqual([
      'signatureSvg',
    ]);
    const mark = moduleByKind.get('search_mark')!;
    expect(missing(mark, { entryType: 'primary' })).toEqual([]);
  });

  it('FL:FR-19: equipment needs its work order and kind; the hours go as a number', () => {
    const equipment = moduleByKind.get('equipment_use')!;
    expect(equipment.photos).toBe(false);
    expect(missing(equipment, { hours: 3 })).toEqual(['missionId', 'equipment']);
    expect(
      commandBody(equipment, {
        missionId: 'm-1',
        equipment: 'chainsaw',
        equipmentNote: ' Saw 2 ',
        hours: 3,
      }),
    ).toEqual({ missionId: 'm-1', equipment: 'chainsaw', equipmentNote: 'Saw 2', hours: 3 });
    expect(equipment.summary({ equipment: 'chainsaw', hours: 3 }, 'es')).toBe('Motosierra: 3 h');
  });
});
