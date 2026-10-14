/**
 * The one-click IDA package (layer-6 task F; DCL:DEC-11, DEC-12, DEC-13,
 * DEC-14, DEC-15, GATE-07, ADM-03): from the package data and the mapping in
 * force for each form,
 * - package.pdf (PDF/UA-1): what the package is and the form versions used,
 *   the IA summary sheet, home insurance matrix and tick sheet, the PA cost
 *   survey and site sheet, Form 010-0-13 data, the outage log, the people in
 *   the affected area and a narrative drafted from the records;
 * - one CSV per per-home and per-site form, and summary.csv with every
 *   summary field (form, section, code, label, value);
 * - pda-layer.geojson: one feature per home at its 100 m cell;
 * - README.txt: scope, as-of time, definitions, exclusions, forms and
 *   mapping versions, and what is not in the package.
 * Counts and representative evidence only: no names, contact details or
 * street addresses (DEC-13). Labelled for state review; never submitted
 * (DEC-14).
 */
import type { Block, PdfDocumentModel } from '@cg/pdf';
import { toCsv } from '../csv.ts';
import { DEFINITIONS } from '../facts.ts';
import { homeTable, siteTable, summarySections, type SectionOut, type TableOut } from './apply.ts';
import { REASON_LABEL, STATUS_LABEL, type PackageData, type Value } from './data.ts';
import { FORMS, type FormKey, type Mapping } from './vocabulary.ts';

export interface PackageFile {
  name: string;
  contentType: string;
  body: string;
}

export interface PackageBuild {
  pdf: PdfDocumentModel;
  files: PackageFile[];
  /** Form → the FEMA form version and mapping version used (DEC-15). */
  mappings: Record<string, { femaFormVersion: string; mappingVersion: number }>;
  /** Figures the tests reconcile with the declaration view and the GIS layer (GATE-07). */
  check: { countedUnits: number; homes: number; features: number; sites: number };
}

const OUTAGE_LABEL: Record<string, string> = {
  hospital: 'Hospital',
  water: 'Drinking water',
  wastewater: 'Wastewater',
  police: 'Police',
  fire_ems: 'Fire and EMS',
  school: 'School',
  child_care: 'Child care',
  eldercare: 'Eldercare',
  roads: 'Roads',
  power: 'Power',
};

const show = (v: Value) =>
  v === null ? 'unknown' : typeof v === 'number' ? v.toLocaleString('en-US') : v;

function sectionBlocks(sections: SectionOut[]): Block[] {
  const out: Block[] = [];
  // Each section is a captioned table under its form's heading; the caption names it once.
  for (const s of sections) {
    if (s.kind === 'pairs')
      out.push({ kind: 'pairs', caption: s.title, items: s.items.map((i) => [i.label, i.value]) });
    else
      out.push({
        kind: 'table',
        caption: s.title,
        columns: ['Category', ...s.columns],
        rowHeaders: true,
        rows: s.rows.map((r, i) => [r, ...s.cells[i]!]),
        widths: [2, ...s.columns.map(() => 1)],
      });
  }
  return out;
}

/** The narrative items FEMA asks for (docs/05), drafted from the records; a person edits them before use. */
function narrative(d: PackageData): string[] {
  const dmg = d.damage;
  const total = d.declaration.profile?.total;
  const byReason = Object.entries(dmg.shownSeparately.inaccessible.byReason)
    .sort((a, b) => b[1] - a[1])
    .map(([r, n]) => `${REASON_LABEL[r] ?? r}: ${n}`)
    .join('; ');
  const sources = new Map<string, number>();
  for (const h of d.homes) {
    const k = `${h.values['home.source'] ?? 'Unknown'} (${String(h.values['home.verification'] ?? 'unknown').toLowerCase()})`;
    sources.set(k, (sources.get(k) ?? 0) + 1);
  }
  const outages = d.declaration.outages.items.filter((o) => o.confirmed && !o.restoredAt);
  const cas = d.declaration.casualties;
  return [
    `Source of the damage information: ${[...sources.entries()].map(([k, n]) => `${k}: ${n}`).join('; ') || 'no records yet'}. Only approved records verified at the desk or in the field are counted.`,
    `Damage: ${show(dmg.counted.units)} housing units counted (${DEFINITIONS.damage.key} version ${DEFINITIONS.damage.version}): ${show(dmg.counted.byDegree.destroyed)} destroyed, ${show(dmg.counted.byDegree.major)} major, ${show(dmg.counted.byDegree.minor)} minor, ${show(dmg.counted.byDegree.affected)} affected.`,
    `Inaccessible areas: ${show(dmg.shownSeparately.inaccessible.total)} homes could not be reached${byReason ? ` (${byReason})` : ''}.`,
    `Utilities and services: ${outages.length} outages open${outages.length ? `: ${outages.map((o) => `${OUTAGE_LABEL[o.kind] ?? o.kind}${o.over72Hours ? ' (over 72 hours)' : ''}`).join(', ')}` : ''}.`,
    `Shelters: ${show(d.shelters.open)} open with ${show(d.shelters.occupancy)} people.`,
    `Fatalities and injuries (official counts only): ${show(cas.deceased?.count ?? null)} deceased, ${show(cas.injured?.count ?? null)} injured, ${show(cas.missing?.count ?? null)} missing.`,
    `Special populations in the affected tracts (Census ACS): ${show(total?.age65Pct ?? null)}% aged 65 and over, ${show(total?.disabilityPct ?? null)}% with a disability, ${show(total?.povertyPct ?? null)}% below poverty, ${show(total?.limitedEnglishHouseholds ?? null)} limited-English households.`,
  ];
}

const tableBlock = (caption: string, t: TableOut, widths?: number[]): Block => ({
  kind: 'table',
  caption,
  columns: t.columns.map((c) => c.label),
  rows: t.rows,
  ...(widths ? { widths } : {}),
});

export function buildPackage(
  d: PackageData,
  mappings: Record<FormKey, Mapping>,
  opts: { productName: string; generatedAt: Date },
): PackageBuild {
  const scope = d.jurisdiction ? `${d.event.name}, ${d.jurisdiction.name}` : d.event.name;
  const asOf = new Intl.DateTimeFormat('en-US', {
    timeZone: d.event.timeZone,
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  }).format(new Date(d.asOf));
  const used = Object.fromEntries(
    (Object.keys(FORMS) as FormKey[]).map((f) => [
      f,
      { femaFormVersion: mappings[f].femaFormVersion, mappingVersion: mappings[f].mappingVersion },
    ]),
  );
  const tables = {
    street: homeTable(mappings.ia_street_sheet, d.homes),
    single: homeTable(mappings.ia_survey_single_family, d.homes),
    multi: homeTable(mappings.ia_survey_multi_family, d.homes),
    sites: siteTable(mappings.pa_site_sheet, d.sites),
    gis: homeTable(mappings.pda_gis_layer, d.homes),
  };
  const summaryForms: FormKey[] = [
    'ia_summary_sheet',
    'home_insurance_matrix',
    'ia_tick_sheet',
    'pa_cost_survey',
    'form_010_0_13',
  ];
  const summaries = Object.fromEntries(
    summaryForms.map((f) => [f, summarySections(mappings[f], d)]),
  );

  // ---- PDF
  const outages = d.declaration.outages.items.filter((o) => o.confirmed);
  const blocks: Block[] = [
    { kind: 'heading', level: 1, text: `Damage assessment package: ${scope}` },
    {
      kind: 'paragraph',
      text: `Draft for state review, prepared from ${d.event.tenantName}'s records with ${opts.productName}. Not submitted to FEMA. Figures as of ${asOf}. Counts and representative evidence only: no names, contact details or street addresses.`,
    },
    { kind: 'heading', level: 2, text: 'About this package' },
    {
      kind: 'pairs',
      caption: 'Scope',
      items: [
        ['Event', d.event.name],
        ['Jurisdiction', d.jurisdiction?.name ?? 'Whole event'],
        ['Figures as of', asOf],
        ['Homes listed', d.homes.length],
        ['Housing units counted', d.damage.counted.units],
        ['Public damage sites', d.sites.length],
      ],
    },
    {
      kind: 'paragraph',
      text: `What is counted: ${DEFINITIONS.damage.text}`,
      small: true,
    },
    {
      kind: 'table',
      caption: 'FEMA forms and the mapping versions used',
      columns: ['Form', 'FEMA form version', 'Mapping version'],
      rowHeaders: true,
      widths: [2, 4, 1],
      rows: (Object.keys(FORMS) as FormKey[]).map((f) => [
        FORMS[f].title,
        used[f]!.femaFormVersion,
        used[f]!.mappingVersion,
      ]),
    },
  ];
  for (const f of summaryForms) {
    blocks.push({ kind: 'heading', level: 2, text: FORMS[f].title });
    blocks.push(...sectionBlocks(summaries[f]!));
  }
  blocks.push(
    { kind: 'heading', level: 2, text: FORMS.pa_site_sheet.title },
    tables.sites.rows.length
      ? tableBlock('Public damage sites', tables.sites)
      : { kind: 'paragraph', text: 'No public damage sites are recorded.' },
    { kind: 'heading', level: 2, text: 'Outage log' },
    outages.length
      ? {
          kind: 'table',
          caption: 'Outages of critical facilities and services (staff-entered or confirmed)',
          columns: [
            'Service',
            'Facility or area',
            'Customers out',
            'Out since',
            'Restored',
            'Hours out',
          ],
          rows: outages.map((o) => [
            OUTAGE_LABEL[o.kind] ?? o.kind,
            [o.facilityName, o.area].filter(Boolean).join(', ') || null,
            o.customersOut,
            o.startedAt.slice(0, 16).replace('T', ' '),
            o.restoredAt ? o.restoredAt.slice(0, 16).replace('T', ' ') : 'Not yet',
            `${Math.round(o.hoursOut)}${o.over72Hours ? ' (over 72)' : ''}`,
          ]),
        }
      : { kind: 'paragraph', text: 'No outages are logged.' },
    { kind: 'heading', level: 2, text: 'Narrative (drafted from the records)' },
    {
      kind: 'paragraph',
      text: 'Drafted by template from the records below; a named person edits and approves it before it is used (RPT-01).',
      small: true,
    },
    { kind: 'list', items: narrative(d) },
    { kind: 'heading', level: 2, text: 'Per-home records' },
    {
      kind: 'paragraph',
      text: `${tables.street.rows.length} homes are listed in ia-street-sheet.csv and pda-layer.geojson (single-family survey: ${tables.single.rows.length}; multi-family survey: ${tables.multi.rows.length}). Each home's place is its 100 m US National Grid cell, ZIP, tract and jurisdiction; low income is the tract's share below poverty, never asked of a household.`,
    },
    {
      kind: 'pairs',
      caption: 'Homes by status',
      items: (Object.keys(STATUS_LABEL) as (keyof typeof STATUS_LABEL)[]).map((s) => [
        STATUS_LABEL[s],
        d.homes.filter((h) => h.status === s).length,
      ]),
    },
  );

  const pdf: PdfDocumentModel = {
    title: `Damage assessment package: ${scope}`,
    lang: 'en-US',
    author: d.event.tenantName,
    subject: 'FEMA preliminary damage assessment data, draft for state review',
    producer: opts.productName,
    footer: `Draft for state review · ${scope} · as of ${asOf}`,
    blocks,
  };

  // ---- CSV, GeoJSON, README
  const csv = (t: TableOut) =>
    toCsv(
      t.columns.map((c) => c.label),
      t.rows,
      { unknown: 'Unknown' },
    );
  const summaryRows: Value[][] = [];
  for (const f of summaryForms)
    for (const s of summaries[f]!)
      if (s.kind === 'pairs')
        for (const i of s.items) summaryRows.push([f, s.title, i.code, i.label, i.value]);
      else
        s.rows.forEach((r, ri) =>
          s.columns.forEach((c, ci) =>
            summaryRows.push([f, s.title, `${r} / ${c}`, `${r}, ${c}`, s.cells[ri]![ci]!]),
          ),
        );
  const features = d.homes.map((h) => ({
    type: 'Feature' as const,
    geometry: h.point ? { type: 'Point' as const, coordinates: h.point } : null,
    properties: Object.fromEntries(
      mappings.pda_gis_layer.fields.map((f) => [f.code, h.values[f.element] ?? null]),
    ),
  }));
  const geojson = {
    type: 'FeatureCollection',
    name: `PDA layer: ${scope}`,
    // Foreign members: what the layer is and which mapping filled it (DEC-15).
    generatedAt: opts.generatedAt.toISOString(),
    asOf: d.asOf,
    mapping: used['pda_gis_layer'],
    features,
  };
  const readme = [
    `Damage assessment package: ${scope}`,
    '',
    `Draft for state review, prepared from ${d.event.tenantName}'s records with ${opts.productName}.`,
    "Not submitted to FEMA. The governor's office files the request (Form 010-0-13).",
    '',
    `Figures as of: ${asOf}`,
    `Generated: ${opts.generatedAt.toISOString()}`,
    `Scope: ${d.jurisdiction ? `homes and public damage sites in ${d.jurisdiction.name}` : 'the whole event'}; outages, casualties, shelters and the population profile are event-wide.`,
    '',
    'What is counted',
    `  ${DEFINITIONS.damage.text}`,
    '  Unknown values read "Unknown", never 0.',
    '',
    'What is not in this package (DEC-13)',
    "  Names, phone numbers, email addresses and street addresses. A home's place is its",
    "  100 m US National Grid cell (and the cell's centre in the GIS layer), ZIP, census tract",
    "  and jurisdiction. Low income is the tract's share below poverty (Census ACS).",
    '',
    'Files',
    '  package.pdf                     the summaries, cost survey, site sheet, Form 010-0-13 data, outages, narrative',
    '  ia-street-sheet.csv             one row per home, counted or shown apart (with the reason)',
    '  ia-survey-single-family.csv     single-family and manufactured homes',
    '  ia-survey-multi-family.csv      multi-family buildings and units',
    '  pa-site-sheet.csv               one row per public damage site',
    '  summary.csv                     every summary field: form, section, code, label, value',
    '  pda-layer.geojson               one point per home at its 100 m cell (WGS 84)',
    '',
    'FEMA forms and mapping versions used (DEC-15)',
    ...(Object.keys(FORMS) as FormKey[]).map(
      (f) =>
        `  ${FORMS[f].title}: mapping version ${used[f]!.mappingVersion} (${used[f]!.femaFormVersion})`,
    ),
    '',
  ].join('\r\n');

  return {
    pdf,
    mappings: used,
    files: [
      { name: 'ia-street-sheet.csv', contentType: 'text/csv', body: csv(tables.street) },
      { name: 'ia-survey-single-family.csv', contentType: 'text/csv', body: csv(tables.single) },
      { name: 'ia-survey-multi-family.csv', contentType: 'text/csv', body: csv(tables.multi) },
      { name: 'pa-site-sheet.csv', contentType: 'text/csv', body: csv(tables.sites) },
      {
        name: 'summary.csv',
        contentType: 'text/csv',
        body: toCsv(['form', 'section', 'code', 'label', 'value'], summaryRows, {
          unknown: 'Unknown',
        }),
      },
      {
        name: 'pda-layer.geojson',
        contentType: 'application/geo+json',
        body: JSON.stringify(geojson),
      },
      { name: 'README.txt', contentType: 'text/plain', body: readme },
    ],
    check: {
      countedUnits: d.damage.counted.units,
      homes: d.homes.length,
      features: features.length,
      sites: d.sites.length,
    },
  };
}
