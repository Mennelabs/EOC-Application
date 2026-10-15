/**
 * The feature service's where subset (layer-6 task H; SCL-09): 1=1, or
 * Field = 'text' and Field = 12 joined by AND on the layer's own fields;
 * anything else is refused with a message and never reaches SQL.
 */
import { describe, expect, it } from 'vitest';
import { matches, parseWhere, type LayerFeature, type LayerField } from '../src/fema/layer.ts';

const fields: LayerField[] = [
  { name: 'Status', alias: 'Status', type: 'string' },
  { name: 'DmgLevel', alias: 'Degree', type: 'string' },
  { name: 'Units', alias: 'Units', type: 'number' },
];
const f = (attributes: LayerFeature['attributes']): LayerFeature => ({
  objectId: 1,
  point: [-94.5, 39.1],
  attributes,
});

describe('PDA layer where subset (SCL-09)', () => {
  it('1=1 or nothing is everything', () => {
    expect(parseWhere(undefined, fields)).toEqual({ ok: true, clauses: [] });
    expect(parseWhere('1=1', fields)).toEqual({ ok: true, clauses: [] });
    expect(parseWhere(' 1 = 1 ', fields)).toEqual({ ok: true, clauses: [] });
  });

  it('equality clauses joined by AND, field names in any case, quotes doubled', () => {
    const r = parseWhere("dmglevel = 'Major' AND Units = 2 and Status='Owner''s'", fields);
    expect(r).toEqual({
      ok: true,
      clauses: [
        { field: 'DmgLevel', value: 'Major' },
        { field: 'Units', value: 2 },
        { field: 'Status', value: "Owner's" },
      ],
    });
    if (!r.ok) return;
    expect(matches(f({ DmgLevel: 'Major', Units: 2, Status: "Owner's" }), r.clauses)).toBe(true);
    expect(matches(f({ DmgLevel: 'Minor', Units: 2, Status: "Owner's" }), r.clauses)).toBe(false);
    expect(matches(f({ DmgLevel: 'Major', Units: null, Status: "Owner's" }), r.clauses)).toBe(
      false,
    );
  });

  it('refuses anything else', () => {
    for (const w of [
      "Status = 'x' OR 1=1",
      '1=1; drop table cg.report',
      "Status <> 'x'",
      "Status LIKE 'x%'",
      "Nope = 'x'",
      "Status = 'unterminated",
      'Units = 1 AND',
      'x'.repeat(1001),
    ])
      expect(parseWhere(w, fields).ok, w).toBe(false);
  });
});
