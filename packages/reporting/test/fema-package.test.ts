/**
 * The IDA package without a database (DCL:DEC-11, DEC-12, DEC-13, DEC-15,
 * GATE-07, BRD:FR-14.06): from synthetic homes run through the counting
 * rule, every summary form, the per-home sheet and the GIS layer agree on
 * the counts; nothing personal or address-like leaves; text that a
 * spreadsheet could run as a formula stays text; a county's mapping
 * version changes the output without code and is named in it; chosen
 * photos travel as their blurred images with captions and generalized
 * places, and a photo with no image is left out and said to be; the PDF
 * renders.
 */
import { describe, expect, it } from 'vitest';
import { renderPdf } from '@cg/pdf';
import { samplePng } from '@cg/pdf/samples';
import { toCsv } from '../src/csv.ts';
import {
  SHIPPED,
  buildPackage,
  samplePackageData,
  type FormKey,
  type Mapping,
} from '../src/fema/index.ts';

const opts = { productName: 'Test Product', generatedAt: new Date('2026-10-14T18:05:00Z') };
const file = (b: ReturnType<typeof buildPackage>, name: string) =>
  b.files.find((f) => f.name === name)!.body.toString();
/** Parses this writer's CSV: quoted fields, doubled quotes, CRLF rows. */
function rows(csv: string): string[][] {
  const text = csv.replace(/^\uFEFF/, '');
  const out: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      row.push(cell);
      cell = '';
    } else if (ch === '\r' && text[i + 1] === '\n') {
      row.push(cell);
      out.push(row);
      row = [];
      cell = '';
      i++;
    } else cell += ch;
  }
  return out;
}

describe('the IDA package', () => {
  const data = samplePackageData();
  const pkg = buildPackage(data, SHIPPED, opts);
  const summary = rows(file(pkg, 'summary.csv'));
  const value = (form: string, code: string) =>
    Number(summary.find((r) => r[0] === form && r[2] === code)![4]);

  it('GATE-07: the summary forms, the street sheet and the GIS layer agree with the counting rule', () => {
    const units = data.damage.counted.units;
    expect(units).toBeGreaterThan(0);
    expect(pkg.check.countedUnits).toBe(units);
    expect(value('ia_summary_sheet', 'UNITS-TOTAL')).toBe(units);
    const byDegree = ['AFFECTED', 'MINOR', 'MAJOR', 'DESTROYED'].map((d) =>
      value('ia_summary_sheet', `UNITS-${d}`),
    );
    expect(byDegree.reduce((a, b) => a + b, 0)).toBe(units);
    const tick = summary.filter((r) => r[0] === 'ia_tick_sheet').map((r) => Number(r[4]));
    expect(tick.reduce((a, b) => a + b, 0)).toBe(units);
    const tenure = ['UNITS-OWNER', 'UNITS-RENTER', 'UNITS-TEN-UNK'].map((c) =>
      value('ia_summary_sheet', c),
    );
    const other = data.damage.counted.cells
      .filter((c) => c.tenure === 'other')
      .reduce((n, c) => n + c.units, 0);
    expect(tenure.reduce((a, b) => a + b, 0) + other).toBe(units);
    // One row per home on the street sheet and one feature per home in the layer.
    const street = rows(file(pkg, 'ia-street-sheet.csv'));
    expect(street.length - 1).toBe(data.homes.length);
    const layer = JSON.parse(file(pkg, 'pda-layer.geojson')) as {
      features: { properties: Record<string, unknown> }[];
    };
    expect(layer.features).toHaveLength(data.homes.length);
    const counted = data.homes.filter((h) => h.status === 'counted');
    expect(counted.reduce((n, h) => n + Number(h.values['home.units'] ?? 1), 0)).toBe(units);
    expect(value('pa_cost_survey', 'TOTAL')).toBe(167000);
    expect(value('pa_cost_survey', 'VERIFIED')).toBe(125000);
  });

  it('lists every home once with its status, and the surveys split homes from buildings', () => {
    const statuses = new Set(data.homes.map((h) => h.values['home.status']));
    for (const s of [
      'Counted',
      'Self-reported, not verified',
      'Inaccessible',
      'Witness only',
      'Pre-existing damage',
      'Not a primary residence',
      'Not a home',
      'No damage',
      'Verified, awaiting review',
    ])
      expect(statuses, s).toContain(s);
    const multi = rows(file(pkg, 'ia-survey-multi-family.csv'));
    expect(multi.length - 1).toBe(1);
    const single = rows(file(pkg, 'ia-survey-single-family.csv'));
    expect(single.length - 1).toBe(
      data.homes.filter((h) => h.homeType !== 'multi_family' && h.homeType !== 'non_residential')
        .length,
    );
    const inaccessible = rows(file(pkg, 'ia-street-sheet.csv')).find(
      (r) => r[1] === 'Inaccessible',
    )!;
    expect(inaccessible).toContain('Private road or bridge');
  });

  it('DEC-13: no address, parcel or personal detail leaves; places are 100 m cells', () => {
    const all = pkg.files.map((f) => f.body.toString()).join('\n');
    expect(all).not.toMatch(/exercise road|SYN-\d|addressKey|parcel/i);
    const layer = JSON.parse(file(pkg, 'pda-layer.geojson')) as {
      features: { geometry: { coordinates: number[] } | null }[];
    };
    for (const f of layer.features)
      for (const c of f.geometry!.coordinates) expect(Math.round(c * 1000) / 1000).toBe(c);
    expect(String(layer.features.length)).toBeTruthy();
    expect(file(pkg, 'README.txt')).toMatch(
      /Names, phone numbers, email addresses and street addresses/,
    );
  });

  it('BRD:FR-14.06: text a spreadsheet could run as a formula stays text; numbers stay numbers', () => {
    const csv = toCsv(
      ['a', 'b', 'c', 'd'],
      [
        ['=HYPERLINK("x")', '+1', -5, '@SUM(A1)'],
        ['plain, "quoted"', null, 3.5, '\tTab'],
      ],
    );
    expect(csv.startsWith('﻿')).toBe(true);
    const lines = csv.slice(1).split('\r\n');
    expect(lines[1]).toBe(`"'=HYPERLINK(""x"")",'+1,-5,'@SUM(A1)`);
    expect(lines[2]).toBe(`"plain, ""quoted""",,3.5,'\tTab`);
  });

  it('DEC-15: a county mapping version changes the output without code and is named in it', () => {
    const v2: Mapping = {
      ...SHIPPED.ia_summary_sheet,
      mappingVersion: 2,
      femaFormVersion: 'Exercise edition',
      fields: SHIPPED.ia_summary_sheet.fields.map((f) =>
        f.code === 'UNITS-TOTAL' ? { ...f, label: 'Total damaged housing units' } : f,
      ),
    };
    const mappings = { ...SHIPPED, ia_summary_sheet: v2 } as Record<FormKey, Mapping>;
    const custom = buildPackage(data, mappings, opts);
    expect(file(custom, 'summary.csv')).toContain('Total damaged housing units');
    expect(file(custom, 'README.txt')).toContain(
      'IA summary sheet: mapping version 2 (Exercise edition)',
    );
    expect(custom.mappings['ia_summary_sheet']).toEqual({
      femaFormVersion: 'Exercise edition',
      mappingVersion: 2,
    });
  });

  it('renders the package PDF', async () => {
    const pdf = await renderPdf(pkg.pdf);
    expect(pdf.subarray(0, 8).toString()).toBe('%PDF-1.7');
    expect(pkg.pdf.footer).toContain('Draft for state review');
  });

  it('PHO-07, DEC-13: chosen photos travel as blurred images with captions and generalized places', async () => {
    const jpeg = samplePng(1200, 900);
    const withPhotos = buildPackage(data, SHIPPED, {
      ...opts,
      photoImages: new Map([['sample-1', jpeg]]),
    });
    // The second chosen photo has no image (not fetched): left out and said to be.
    expect(withPhotos.check).toMatchObject({ photos: 1, photosLeftOut: 1 });
    expect(withPhotos.files.find((f) => f.name === 'photos/photo-01.jpg')!.body).toBe(jpeg);
    expect(withPhotos.files.some((f) => f.name === 'photos/photo-02.jpg')).toBe(false);
    const listed = rows(file(withPhotos, 'photos.csv'));
    expect(listed[0]).toEqual([
      'file',
      'subject',
      'caption',
      'usng',
      'zip',
      'tract',
      'jurisdiction',
      'site',
    ]);
    expect(listed[1]).toEqual([
      'photos/photo-01.jpg',
      'Home',
      'Exercise: water line about three feet up a living room wall.',
      '15S YC 012 345',
      '63399',
      '29999000100',
      'Harmon City',
      '',
    ]);
    const readme = file(withPhotos, 'README.txt');
    expect(readme).toContain('1 chosen by county staff');
    expect(readme).toContain('1 chosen photo(s) left out');
    const figures = withPhotos.pdf.blocks.filter((b) => b.kind === 'figure');
    expect(figures).toHaveLength(1);
    expect(figures[0]).toMatchObject({
      alt: 'Exercise: water line about three feet up a living room wall.',
    });
    expect((figures[0] as { caption: string }).caption).toContain('15S YC 012 345 (100 m cell)');
    expect((await renderPdf(withPhotos.pdf)).toString('latin1')).toContain('/S /Figure');
    // Without images, no photo files and the README says none are shown.
    expect(pkg.files.some((f) => f.name.startsWith('photos'))).toBe(false);
    expect(pkg.check).toMatchObject({ photos: 0, photosLeftOut: 2 });
  });
});
