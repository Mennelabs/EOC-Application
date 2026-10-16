/**
 * Declaration request data, per event (layer-6 task D; DCL:DEC-05–DEC-10,
 * DEC-14, DEC-16, DEC-17, FL-17, RULE-02, ACC-07, WCAG 2.2 AA). Everything a
 * request needs, gathered from records for the state's review and never sent
 * to FEMA from here: the 30-day filing clock, verified damage by the
 * counting rule with what is shown apart (self-reported, awaiting review,
 * homes that could not be reached and why), the population of the affected
 * area with its source, the outage log, official casualty counts with their
 * sources, public damage by category against the per-capita indicators, and
 * volunteer hours donated. Tables first; a form beside each part for the
 * staff who may enter it. Unknown is shown as unknown, never as zero.
 */
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api, ApiFailure, describeFailure } from '../api/client.ts';
import { DataTable, Field, Status, fmt } from '../ui/primitives.tsx';
import { EventPicker, useOpenEvents } from './dispatch.tsx';
import { PackageExports, PackagePhotos } from './fema-package.tsx';
import { PartnerRollupChooser } from './partner-rollup.tsx';
import { fromZoneInput } from '../ui/time.ts';

const DEGREES = ['affected', 'minor', 'major', 'destroyed'] as const;
type Degree = (typeof DEGREES)[number];
export const DEGREE_NAMES: Record<Degree, string> = {
  affected: 'Affected',
  minor: 'Minor',
  major: 'Major',
  destroyed: 'Destroyed',
};
const TENURE: Record<string, string> = {
  owner: 'Owner',
  renter: 'Renter',
  other: 'Other',
  unknown: 'Unknown',
};
const INSURANCE: Record<string, string> = {
  insured: 'Insured',
  uninsured: 'Not insured',
  unknown: 'Unknown',
};
const HOME_TYPES: Record<string, string> = {
  single_family: 'Single-family home',
  multi_family: 'Apartment or condo (by unit)',
  manufactured: 'Manufactured home',
  other: 'Other',
  unknown: 'Unknown',
};
const VERIFICATION: Record<string, string> = {
  desktop_verified: 'Verified at the desk',
  field_verified: 'Verified in the field',
};
const REACH: Record<string, string> = {
  private_road_or_bridge: 'Private road or bridge out',
  public_road_or_bridge: 'Public road or bridge blocked',
  flood_water: 'Flood water',
  debris: 'Debris',
  hazard: 'Hazard',
  no_permission: 'No permission to enter',
  other: 'Other reason',
  'not given': 'Reason not given',
};
const OUTAGE_KINDS = {
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
} as const;
type OutageKind = keyof typeof OUTAGE_KINDS;
const CATEGORIES = {
  A: 'A: Debris removal',
  B: 'B: Emergency protective measures',
  C: 'C: Roads and bridges',
  D: 'D: Water control facilities',
  E: 'E: Buildings and equipment',
  F: 'F: Utilities',
  G: 'G: Parks, recreation and other',
} as const;
type Category = keyof typeof CATEGORIES;
const CASUALTY_KINDS = { injured: 'Injured', missing: 'Missing', deceased: 'Deceased' } as const;
type CasualtyKind = keyof typeof CASUALTY_KINDS;
const PROGRAMS = ['IA', 'PA', 'HM', 'IH'] as const;
const PROGRAM_NAMES: Record<(typeof PROGRAMS)[number], string> = {
  IA: 'Individual Assistance',
  PA: 'Public Assistance',
  HM: 'Hazard Mitigation',
  IH: 'Individuals and Households',
};
const YNU: Record<string, string> = { yes: 'Yes', no: 'No', unknown: 'Unknown' };
const DRAFT_LIMIT = 3000;

interface Declaration {
  id: string;
  version: number;
  incidentType: string | null;
  incidentStart: string | null;
  incidentEnd: string | null;
  requestedAreas: { name: string; programs: string[] }[];
  box8Draft: string | null;
  box9Draft: string | null;
  reviewLabel: string;
  updatedAt: string;
}

interface Cell {
  degree: Degree;
  tenure: string;
  insurance: string;
  homeType: string;
  verification: string;
  units: number;
}

interface Outage {
  id: string;
  version: number;
  kind: OutageKind;
  facilityName: string | null;
  description: string | null;
  area: string | null;
  customersOut: number | null;
  startedAt: string;
  expectedRestorationAt: string | null;
  restoredAt: string | null;
  source: 'staff' | 'feed_suggestion' | 'utility_report';
  confirmed: boolean;
  hoursOut: number;
  over72Hours: boolean;
}

interface Casualty {
  count: number;
  officialSource: string;
  asOf: string;
  entries: number;
}

interface PaSite {
  id: string;
  version: number;
  applicant: string;
  name: string;
  category: Category;
  estimatedCost: number | null;
  costBasis: 'estimate' | 'verified';
  percentComplete: number | null;
  insured: string;
  otherFederalAgency: string;
  debrisCubicYards: number | null;
  status: 'active' | 'withdrawn';
  photos: number;
}

interface Citation {
  snapshotId: string;
  vintage: string | null;
  retrievedAt: string;
}

export interface View {
  eventId: string;
  asOf: string;
  declaration: Declaration | null;
  clock: { incidentEnd: string; deadline: string; daysLeft: number; overdue: boolean } | null;
  damage: {
    counted: {
      units: number;
      homes: number;
      unknownUnitBuildings: number;
      byDegree: Record<Degree, number>;
      cells: Cell[];
      byTract: { tractGeoid: string | null; units: number; byDegree: Record<Degree, number> }[];
    };
    shownSeparately: {
      selfReported: number;
      awaitingReview: number;
      inaccessible: { total: number; byReason: Record<string, number> };
      witness: number;
      preExisting: number;
      notPrimaryResidence: number;
      nonResidential: number;
      noDamage: number;
      degreeNotSet: number;
    };
    merged: number;
    excluded: { withdrawn: number; rejected: number };
  };
  profile: {
    basis: 'footprint' | 'reports' | 'none';
    tracts: Citation | null;
    profiles: Citation | null;
    missing: string[];
    total: {
      tracts: number;
      population: number | null;
      households: number | null;
      renterHouseholds: number | null;
      povertyPct: number | null;
      snapHouseholdsPct: number | null;
      ssiHouseholdsPct: number | null;
      age65Pct: number | null;
      disabilityPct: number | null;
      limitedEnglishHouseholds: number | null;
      noVehicleHouseholds: number | null;
    };
  };
  outages: { items: Outage[]; open: number; over72Hours: number; unconfirmed: number };
  casualties: Record<CasualtyKind, Casualty | null>;
  publicAssistance: {
    sites: number;
    byCategory: Record<Category, { sites: number; cost: number }>;
    totalCost: number;
    verifiedCost: number;
    indicators: {
      statewidePerCapita: number | null;
      countywidePerCapita: number | null;
      statePopulation: number | null;
      fiscalYear: string | null;
      countyPopulation: number | null;
      countyThreshold: number | null;
      stateThreshold: number | null;
      meetsCounty: boolean | null;
      meetsState: boolean | null;
    };
  };
  donated: {
    volunteerHours: number;
    includesOpenShifts: boolean;
    byOrganization: { organization: string; hours: number; people: number }[];
    /** FL-17: equipment partners' teams brought, with the team's time on duty. */
    equipment?: { organization: string; team: string; item: string; hours: number }[];
  };
  /**
   * DCL:DEC-09: what partner organizations committed, from their own records; all of it, or
   * the organizations and categories the county chose (2026-10-15). A category left out is
   * null: not included, never zero. Absent from an older API.
   */
  partners?: {
    rollup?: {
      all: boolean;
      partners: { id: string; organization: string }[];
      categories: string[];
      statement: string;
    };
    organizations?: { id: string; organization: string }[];
    byOrganization: {
      id?: string;
      organization: string;
      needsMet: number | null;
      services: Record<string, number> | null;
      shelteredHouseholds: number | null;
      shelteredPeople: number | null;
      teams: number | null;
    }[];
    totals: {
      needsMet: number | null;
      meals: number | null;
      waterCases: number | null;
      tarps: number | null;
      cots: number | null;
      rides: number | null;
      peopleServed: number | null;
      shelteredHouseholds: number | null;
      shelteredPeople: number | null;
      teams: number | null;
    };
  };
}

const n = (v: number | null | undefined) =>
  v === null || v === undefined ? 'Unknown' : v.toLocaleString('en-US');
const pct = (v: number | null) => (v === null ? 'Unknown' : `${v.toLocaleString('en-US')}%`);
const usd = (v: number | null) =>
  v === null
    ? 'Unknown'
    : v.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
/** A datetime-local value as an ISO instant; empty stays empty. */
const instant = (v: string) => (v ? fromZoneInput(v).toISOString() : null);

export function DeclarationScreen() {
  const { events, error: eventsError } = useOpenEvents();
  const [picked, setEventId] = useState<string | null>(null);
  // The first open event until the person picks one.
  const eventId = picked ?? events?.[0]?.id ?? null;
  const [view, setView] = useState<View | null>(null);
  const [sites, setSites] = useState<PaSite[]>([]);
  const [actions, setActions] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);

  useEffect(() => {
    let live = true;
    api<{ actions: string[] }>('/me')
      .then((me) => live && setActions(me.actions))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);
  const reload = useCallback(() => {
    if (!eventId) return;
    Promise.all([
      api<View>(`/events/${eventId}/declaration`),
      api<PaSite[]>(`/events/${eventId}/pa-sites`),
    ])
      .then(([v, s]) => {
        setView(v);
        setSites(s);
        setError(null);
      })
      .catch((err: unknown) => setError(describeFailure(err)));
  }, [eventId]);
  useEffect(reload, [reload]);

  /** Runs a change, says what happened, and reloads; a conflict asks the person to look again. */
  const run = async (fn: () => Promise<unknown>, done: string) => {
    setMsg(null);
    try {
      await fn();
      setMsg({ kind: 'success', text: done });
      reload();
      return true;
    } catch (err) {
      const conflict = err instanceof ApiFailure && err.status === 409;
      setMsg({
        kind: 'error',
        text: conflict
          ? 'Someone changed this while you were editing. The page now shows their version; check it and try again.'
          : describeFailure(err),
      });
      if (conflict) reload();
      return false;
    }
  };
  const can = (a: string) => actions.includes(a);

  return (
    <section aria-labelledby="decl-h">
      <h1 id="decl-h">Declaration request data</h1>
      <p>
        What a declaration request needs, gathered from records for the state’s review. Nothing here
        is sent to FEMA. Counts follow the counting rule: only approved, verified damage to primary
        residences is counted; everything else is shown apart.
      </p>
      {eventsError ? <Status kind="error">{eventsError}</Status> : null}
      {events && events.length === 0 ? <p>There is no open event.</p> : null}
      {events && events.length > 0 ? (
        <EventPicker events={events} value={eventId} onChange={setEventId} />
      ) : null}
      {error ? <Status kind="error">{error}</Status> : null}
      {msg ? <Status kind={msg.kind}>{msg.text}</Status> : null}
      {!view && !error && eventId ? <p role="status">Loading the declaration data…</p> : null}
      {view ? (
        <>
          <p className="hint">
            {view.declaration?.reviewLabel ?? 'Draft for state review'}. Figures as of{' '}
            {fmt(view.asOf)}.
          </p>
          <Clock view={view} />
          <IncidentForm
            key={`${view.eventId}-${view.declaration?.version ?? 0}`}
            eventId={view.eventId}
            declaration={view.declaration}
            editable={can('declaration.write')}
            run={run}
          />
          <Damage view={view} />
          <Profile view={view} />
          <Outages view={view} editable={can('outage.write')} run={run} />
          <Casualties view={view} editable={can('casualty.record')} run={run} />
          <PublicDamage view={view} sites={sites} editable={can('pa_site.write')} run={run} />
          <Donated view={view} />
          <Partners view={view} editable={can('declaration.write')} run={run} />
          <PackagePhotos eventId={view.eventId} canChoose={can('declaration.export')} />
          <PackageExports eventId={view.eventId} canExport={can('declaration.export')} />
        </>
      ) : null}
    </section>
  );
}

export type Run = (fn: () => Promise<unknown>, done: string) => Promise<boolean>;

export function Clock({ view }: { view: View }) {
  const c = view.clock;
  return (
    <section aria-labelledby="decl-clock">
      <h2 id="decl-clock">Filing deadline</h2>
      {!c ? (
        <p>Enter the incident end date below to start the 30-day clock.</p>
      ) : c.overdue ? (
        <Status kind="error">
          The request was due {c.deadline}, 30 days after the incident ended on {c.incidentEnd}. It
          is {Math.abs(c.daysLeft)} days late; the state can ask FEMA for more time.
        </Status>
      ) : (
        <p>
          The request is due by <strong>{c.deadline}</strong>, 30 days after the incident ended on{' '}
          {c.incidentEnd}: {c.daysLeft} {c.daysLeft === 1 ? 'day' : 'days'} left.
        </p>
      )}
    </section>
  );
}

function IncidentForm({
  eventId,
  declaration,
  editable,
  run,
}: {
  eventId: string;
  declaration: Declaration | null;
  editable: boolean;
  run: Run;
}) {
  const [form, setForm] = useState({
    incidentType: declaration?.incidentType ?? '',
    incidentStart: declaration?.incidentStart ?? '',
    incidentEnd: declaration?.incidentEnd ?? '',
    areas: declaration?.requestedAreas ?? [],
    box8: declaration?.box8Draft ?? '',
    box9: declaration?.box9Draft ?? '',
  });
  // Layer-7 task G (DCL:DEC-14): an AI draft fills a box; the person reads, changes and saves it.
  type AiBox = { outputId: string; text: string; provider: string; model: string };
  const [ai, setAi] = useState<{ 8?: AiBox; 9?: AiBox }>({});
  const [aiMsg, setAiMsg] = useState<{ box: 8 | 9; kind: 'info' | 'error'; text: string } | null>(
    null,
  );
  const draftBox = async (box: 8 | 9) => {
    setAiMsg(null);
    try {
      const r = await api<AiBox & { box: number }>(`/events/${eventId}/declaration/ai-draft`, {
        body: { box, language: 'en' },
      });
      setForm((f) => ({ ...f, [`box${box}`]: r.text }));
      setAi((a) => ({ ...a, [box]: r }));
      setAiMsg({
        box,
        kind: 'info',
        text: `Box ${box} drafted by the AI assistant (${r.provider}, ${r.model}) from the declaration figures; every figure was checked against them. Read it and change what needs changing, then save.`,
      });
    } catch (err) {
      setAiMsg({ box, kind: 'error', text: describeFailure(err) });
    }
  };
  const endError =
    form.incidentStart && form.incidentEnd && form.incidentEnd < form.incidentStart
      ? 'The incident cannot end before it starts.'
      : undefined;
  const save = (e: FormEvent) => {
    e.preventDefault();
    if (endError) return;
    void run(
      () =>
        api(`/events/${eventId}/declaration`, {
          method: 'PUT',
          body: {
            incidentType: form.incidentType.trim() || null,
            incidentStart: form.incidentStart || null,
            incidentEnd: form.incidentEnd || null,
            requestedAreas: form.areas.filter((a) => a.name.trim()),
            box8Draft: form.box8.trim() || null,
            box9Draft: form.box9.trim() || null,
            ...(ai[8] || ai[9]
              ? {
                  ai: ([8, 9] as const)
                    .filter((b) => ai[b])
                    .map((b) => ({
                      outputId: ai[b]!.outputId,
                      changed: form[`box${b}`].trim() !== ai[b]!.text.trim(),
                    })),
                }
              : {}),
          },
          ...(declaration ? { version: declaration.version } : {}),
        }).then((r) => {
          setAi({});
          return r;
        }),
      'Incident period and drafts saved.',
    );
  };
  const setArea = (i: number, a: { name: string; programs: string[] }) =>
    setForm({ ...form, areas: form.areas.map((x, j) => (j === i ? a : x)) });
  if (!editable)
    return (
      <section aria-labelledby="decl-incident">
        <h2 id="decl-incident">Incident period</h2>
        <dl className="meta">
          <dt>Incident type</dt>
          <dd>{declaration?.incidentType ?? 'Not entered'}</dd>
          <dt>Incident period</dt>
          <dd>
            {declaration?.incidentStart ?? 'Start not entered'} to{' '}
            {declaration?.incidentEnd ?? 'end not entered'}
          </dd>
          <dt>Requested areas</dt>
          <dd>
            {declaration?.requestedAreas.length
              ? declaration.requestedAreas
                  .map((a) => `${a.name} (${a.programs.join(', ') || 'no programs'})`)
                  .join('; ')
              : 'None entered'}
          </dd>
        </dl>
      </section>
    );
  return (
    <section aria-labelledby="decl-incident">
      <h2 id="decl-incident">Incident period</h2>
      <form onSubmit={save} className="form-grid">
        <Field label="Incident type" hint="For example: severe storms and flooding.">
          {({ id, describedBy }) => (
            <input
              id={id}
              aria-describedby={describedBy}
              value={form.incidentType}
              maxLength={80}
              onChange={(e) => setForm({ ...form, incidentType: e.target.value })}
            />
          )}
        </Field>
        <Field label="Incident start date">
          {({ id }) => (
            <input
              id={id}
              type="date"
              value={form.incidentStart}
              onChange={(e) => setForm({ ...form, incidentStart: e.target.value })}
            />
          )}
        </Field>
        <Field
          label="Incident end date"
          hint="Starts the 30-day clock."
          {...(endError ? { error: endError } : {})}
        >
          {({ id, describedBy, invalid }) => (
            <input
              id={id}
              type="date"
              aria-describedby={describedBy}
              aria-invalid={invalid}
              value={form.incidentEnd}
              onChange={(e) => setForm({ ...form, incidentEnd: e.target.value })}
            />
          )}
        </Field>
        <fieldset>
          <legend>Requested areas</legend>
          {form.areas.length === 0 ? <p>No areas yet.</p> : null}
          {form.areas.map((a, i) => (
            <fieldset key={i}>
              <legend>Area {i + 1}</legend>
              <Field label={`Area ${i + 1} name`}>
                {({ id }) => (
                  <input
                    id={id}
                    value={a.name}
                    maxLength={120}
                    onChange={(e) => setArea(i, { ...a, name: e.target.value })}
                  />
                )}
              </Field>
              {PROGRAMS.map((p) => (
                <label key={p} className="inline">
                  <input
                    type="checkbox"
                    checked={a.programs.includes(p)}
                    onChange={(e) =>
                      setArea(i, {
                        ...a,
                        programs: e.target.checked
                          ? [...a.programs, p]
                          : a.programs.filter((x) => x !== p),
                      })
                    }
                  />{' '}
                  {PROGRAM_NAMES[p]} ({p})
                </label>
              ))}
              <button
                type="button"
                onClick={() => setForm({ ...form, areas: form.areas.filter((_, j) => j !== i) })}
              >
                Remove area {i + 1}
              </button>
            </fieldset>
          ))}
          <button
            type="button"
            onClick={() => setForm({ ...form, areas: [...form.areas, { name: '', programs: [] }] })}
          >
            Add an area
          </button>
        </fieldset>
        <Field
          label="Box 8 draft: the incident and its effects"
          hint={`${form.box8.length.toLocaleString('en-US')} of ${DRAFT_LIMIT.toLocaleString('en-US')} characters.`}
        >
          {({ id, describedBy }) => (
            <textarea
              id={id}
              aria-describedby={describedBy}
              rows={6}
              maxLength={DRAFT_LIMIT}
              value={form.box8}
              onChange={(e) => setForm({ ...form, box8: e.target.value })}
            />
          )}
        </Field>
        <div className="toolbar">
          <button type="button" onClick={() => void draftBox(8)}>
            Draft Box 8 with the AI assistant
          </button>
        </div>
        {aiMsg?.box === 8 ? <Status kind={aiMsg.kind}>{aiMsg.text}</Status> : null}
        <Field
          label="Box 9 draft: actions taken and resources committed"
          hint={`${form.box9.length.toLocaleString('en-US')} of ${DRAFT_LIMIT.toLocaleString('en-US')} characters.`}
        >
          {({ id, describedBy }) => (
            <textarea
              id={id}
              aria-describedby={describedBy}
              rows={6}
              maxLength={DRAFT_LIMIT}
              value={form.box9}
              onChange={(e) => setForm({ ...form, box9: e.target.value })}
            />
          )}
        </Field>
        <div className="toolbar">
          <button type="button" onClick={() => void draftBox(9)}>
            Draft Box 9 with the AI assistant
          </button>
        </div>
        {aiMsg?.box === 9 ? <Status kind={aiMsg.kind}>{aiMsg.text}</Status> : null}
        <div className="toolbar">
          <button type="submit" className="primary">
            Save incident period and drafts
          </button>
        </div>
      </form>
    </section>
  );
}

export function Damage({ view }: { view: View }) {
  const d = view.damage;
  const s = d.shownSeparately;
  const apart: { label: string; count: number }[] = [
    { label: 'Self-reported, not yet verified', count: s.selfReported },
    { label: 'Verified, awaiting review', count: s.awaitingReview },
    ...Object.entries(s.inaccessible.byReason)
      .sort((a, b) => b[1] - a[1])
      .map(([reason, count]) => ({
        label: `Could not be reached: ${REACH[reason] ?? reason}`,
        count,
      })),
    { label: 'Seen by a witness, not the household', count: s.witness },
    { label: 'Damage from before the incident', count: s.preExisting },
    { label: 'Not a primary residence', count: s.notPrimaryResidence },
    { label: 'Not a home (business or public building)', count: s.nonResidential },
    { label: 'No damage', count: s.noDamage },
    { label: 'Degree of damage not set', count: s.degreeNotSet },
  ];
  return (
    <section aria-labelledby="decl-damage">
      <h2 id="decl-damage">Verified damage to homes</h2>
      <p>
        {d.counted.homes.toLocaleString('en-US')} homes counted,{' '}
        {d.counted.units.toLocaleString('en-US')} housing units.
        {d.counted.unknownUnitBuildings
          ? ` ${d.counted.unknownUnitBuildings} apartment ${d.counted.unknownUnitBuildings === 1 ? 'building is' : 'buildings are'} counted as one unit because the number of homes in it is unknown.`
          : ''}{' '}
        {d.merged.toLocaleString('en-US')} further records describe a home already counted;{' '}
        {d.excluded.withdrawn} withdrawn and {d.excluded.rejected} rejected records are left out.
      </p>
      <DataTable
        caption="Counted housing units by degree of damage"
        rows={[...DEGREES]}
        rowKey={(k) => k}
        columns={[
          { key: 'degree', header: 'Degree of damage', render: (k) => DEGREE_NAMES[k] },
          { key: 'units', header: 'Housing units', render: (k) => n(d.counted.byDegree[k]) },
        ]}
      />
      <DataTable
        caption="Counted housing units by occupancy, insurance, home type and verification"
        rows={d.counted.cells}
        rowKey={(c) => `${c.degree}|${c.tenure}|${c.insurance}|${c.homeType}|${c.verification}`}
        empty="No verified damage is counted yet."
        columns={[
          { key: 'degree', header: 'Degree', render: (c) => DEGREE_NAMES[c.degree] },
          { key: 'tenure', header: 'Occupancy', render: (c) => TENURE[c.tenure] ?? c.tenure },
          {
            key: 'insurance',
            header: 'Insurance',
            render: (c) => INSURANCE[c.insurance] ?? c.insurance,
          },
          { key: 'home', header: 'Home type', render: (c) => HOME_TYPES[c.homeType] ?? c.homeType },
          {
            key: 'verification',
            header: 'Verified',
            render: (c) => VERIFICATION[c.verification] ?? c.verification,
          },
          { key: 'units', header: 'Housing units', render: (c) => n(c.units) },
        ]}
      />
      <DataTable
        caption="Shown apart, not counted"
        rows={apart}
        rowKey={(r) => r.label}
        columns={[
          { key: 'what', header: 'Records', render: (r) => r.label },
          { key: 'count', header: 'Homes', render: (r) => n(r.count) },
        ]}
      />
      <DataTable
        caption="Counted housing units by census tract"
        rows={d.counted.byTract}
        rowKey={(t) => t.tractGeoid ?? 'none'}
        empty="No verified damage is counted yet."
        columns={[
          {
            key: 'tract',
            header: 'Census tract',
            render: (t) => t.tractGeoid ?? 'Not yet placed in a tract',
          },
          ...DEGREES.map((k) => ({
            key: k,
            header: DEGREE_NAMES[k],
            render: (t: View['damage']['counted']['byTract'][number]) => n(t.byDegree[k]),
          })),
          { key: 'units', header: 'All degrees', render: (t) => n(t.units) },
        ]}
      />
    </section>
  );
}

export function Profile({ view }: { view: View }) {
  const p = view.profile;
  const t = p.total;
  const source = p.profiles
    ? `Census Bureau American Community Survey${p.profiles.vintage ? ` ${p.profiles.vintage}` : ''}, retrieved ${fmt(p.profiles.retrievedAt)}.`
    : 'No population profile is loaded yet; see Reference data.';
  return (
    <section aria-labelledby="decl-profile">
      <h2 id="decl-profile">People in the affected area</h2>
      <p>
        {p.basis === 'footprint'
          ? `The census tracts the event covers (${t.tracts}).`
          : p.basis === 'reports'
            ? `The census tracts with reports in this event (${t.tracts}); the event has no mapped footprint.`
            : 'No tracts yet: the event has no footprint and no reports placed in a tract.'}{' '}
        {source}
        {p.missing.length
          ? ` ${p.missing.length} ${p.missing.length === 1 ? 'tract has' : 'tracts have'} no profile, so totals that need them read unknown.`
          : ''}
      </p>
      <dl className="meta">
        <dt>Population</dt>
        <dd>{n(t.population)}</dd>
        <dt>Households</dt>
        <dd>{n(t.households)}</dd>
        <dt>Renter households</dt>
        <dd>{n(t.renterHouseholds)}</dd>
        <dt>Below poverty</dt>
        <dd>{pct(t.povertyPct)}</dd>
        <dt>Households with SNAP</dt>
        <dd>{pct(t.snapHouseholdsPct)}</dd>
        <dt>Households with SSI</dt>
        <dd>{pct(t.ssiHouseholdsPct)}</dd>
        <dt>Aged 65 and over</dt>
        <dd>{pct(t.age65Pct)}</dd>
        <dt>With a disability</dt>
        <dd>{pct(t.disabilityPct)}</dd>
        <dt>Limited-English households</dt>
        <dd>{n(t.limitedEnglishHouseholds)}</dd>
        <dt>Households without a vehicle</dt>
        <dd>{n(t.noVehicleHouseholds)}</dd>
      </dl>
    </section>
  );
}

export function Outages({ view, editable, run }: { view: View; editable: boolean; run: Run }) {
  const o = view.outages;
  const blank = {
    kind: 'power' as OutageKind,
    facilityName: '',
    area: '',
    customersOut: '',
    startedAt: '',
    expectedRestorationAt: '',
  };
  const [form, setForm] = useState(blank);
  const customers = form.customersOut.trim();
  const customersError =
    customers && !/^\d+$/.test(customers) ? 'Enter a whole number, or leave it empty.' : undefined;
  const add = (e: FormEvent) => {
    e.preventDefault();
    if (customersError || !form.startedAt) return;
    void run(
      () =>
        api(`/events/${view.eventId}/outages`, {
          body: {
            clientUuid: crypto.randomUUID(),
            kind: form.kind,
            facilityName: form.facilityName.trim() || null,
            area: form.area.trim() || null,
            customersOut: customers ? Number(customers) : null,
            startedAt: instant(form.startedAt),
            expectedRestorationAt: instant(form.expectedRestorationAt),
          },
        }),
      'Outage logged.',
    ).then((ok) => ok && setForm(blank));
  };
  return (
    <section aria-labelledby="decl-outages">
      <h2 id="decl-outages">Outages of critical facilities and services</h2>
      <p>
        {o.open} open; {o.over72Hours} out longer than 72 hours.
        {o.unconfirmed
          ? ` ${o.unconfirmed} suggested by a feed and not counted until a person confirms ${o.unconfirmed === 1 ? 'it' : 'them'}.`
          : ''}
      </p>
      <DataTable
        caption="Outage log"
        rows={o.items}
        rowKey={(r) => r.id}
        empty="No outages logged for this event."
        columns={[
          { key: 'kind', header: 'Service', render: (r) => OUTAGE_KINDS[r.kind] },
          {
            key: 'what',
            header: 'Facility or area',
            render: (r) => [r.facilityName, r.area].filter(Boolean).join(', ') || 'Not given',
          },
          { key: 'customers', header: 'Customers out', render: (r) => n(r.customersOut) },
          { key: 'start', header: 'Out since', render: (r) => fmt(r.startedAt) },
          {
            key: 'restore',
            header: 'Restored or expected',
            render: (r) =>
              r.restoredAt
                ? `Restored ${fmt(r.restoredAt)}`
                : r.expectedRestorationAt
                  ? `Expected ${fmt(r.expectedRestorationAt)}`
                  : 'Not known',
          },
          {
            key: 'hours',
            header: 'Hours out',
            render: (r) =>
              `${Math.round(r.hoursOut).toLocaleString('en-US')}${r.over72Hours ? ' (over 72 hours)' : ''}`,
          },
          {
            key: 'source',
            header: 'Source',
            render: (r) =>
              r.source === 'staff'
                ? 'Staff'
                : `${r.source === 'utility_report' ? 'Utility report' : 'Feed suggestion'}${r.confirmed ? ', confirmed' : ', not confirmed'}`,
          },
          ...(editable
            ? [
                {
                  key: 'act',
                  header: 'Actions',
                  render: (r: Outage) => (
                    <div className="actions">
                      {!r.confirmed ? (
                        <button
                          type="button"
                          onClick={() =>
                            void run(
                              () =>
                                api(`/outages/${r.id}/confirm`, {
                                  method: 'POST',
                                  version: r.version,
                                }),
                              `${OUTAGE_KINDS[r.kind]} outage confirmed.`,
                            )
                          }
                        >
                          Confirm {OUTAGE_KINDS[r.kind].toLowerCase()} outage
                        </button>
                      ) : null}
                      {!r.restoredAt ? (
                        <button
                          type="button"
                          onClick={() =>
                            void run(
                              () =>
                                api(`/outages/${r.id}`, {
                                  method: 'PATCH',
                                  version: r.version,
                                  body: { restoredAt: new Date().toISOString() },
                                }),
                              `${OUTAGE_KINDS[r.kind]} marked restored.`,
                            )
                          }
                        >
                          Mark {OUTAGE_KINDS[r.kind].toLowerCase()} restored now
                        </button>
                      ) : null}
                    </div>
                  ),
                },
              ]
            : []),
        ]}
      />
      {editable ? (
        <form onSubmit={add} className="form-grid" aria-labelledby="decl-outage-add">
          <h3 id="decl-outage-add">Log an outage</h3>
          <Field label="Service">
            {({ id }) => (
              <select
                id={id}
                value={form.kind}
                onChange={(e) => setForm({ ...form, kind: e.target.value as OutageKind })}
              >
                {(Object.keys(OUTAGE_KINDS) as OutageKind[]).map((k) => (
                  <option key={k} value={k}>
                    {OUTAGE_KINDS[k]}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <Field label="Facility name (optional)">
            {({ id }) => (
              <input
                id={id}
                value={form.facilityName}
                maxLength={200}
                onChange={(e) => setForm({ ...form, facilityName: e.target.value })}
              />
            )}
          </Field>
          <Field label="Area (optional)" hint="Where it is out, without home addresses.">
            {({ id, describedBy }) => (
              <input
                id={id}
                aria-describedby={describedBy}
                value={form.area}
                maxLength={300}
                onChange={(e) => setForm({ ...form, area: e.target.value })}
              />
            )}
          </Field>
          <Field
            label="Customers out (optional)"
            {...(customersError ? { error: customersError } : {})}
          >
            {({ id, describedBy, invalid }) => (
              <input
                id={id}
                inputMode="numeric"
                aria-describedby={describedBy}
                aria-invalid={invalid}
                value={form.customersOut}
                onChange={(e) => setForm({ ...form, customersOut: e.target.value })}
              />
            )}
          </Field>
          <Field label="Out since">
            {({ id }) => (
              <input
                id={id}
                type="datetime-local"
                required
                value={form.startedAt}
                onChange={(e) => setForm({ ...form, startedAt: e.target.value })}
              />
            )}
          </Field>
          <Field label="Expected restoration (optional)">
            {({ id }) => (
              <input
                id={id}
                type="datetime-local"
                value={form.expectedRestorationAt}
                onChange={(e) => setForm({ ...form, expectedRestorationAt: e.target.value })}
              />
            )}
          </Field>
          <div className="toolbar">
            <button type="submit" className="primary">
              Log outage
            </button>
          </div>
        </form>
      ) : null}
    </section>
  );
}

export function Casualties({ view, editable, run }: { view: View; editable: boolean; run: Run }) {
  const kinds = Object.keys(CASUALTY_KINDS) as CasualtyKind[];
  const blank = {
    kind: 'injured' as CasualtyKind,
    count: '',
    officialSource: '',
    asOf: '',
    note: '',
  };
  const [form, setForm] = useState(blank);
  const countError =
    form.count.trim() && !/^\d+$/.test(form.count.trim()) ? 'Enter a whole number.' : undefined;
  const add = (e: FormEvent) => {
    e.preventDefault();
    if (countError || !form.count.trim() || !form.asOf) return;
    void run(
      () =>
        api(`/events/${view.eventId}/casualties`, {
          body: {
            kind: form.kind,
            count: Number(form.count.trim()),
            officialSource: form.officialSource.trim(),
            asOf: instant(form.asOf),
            ...(form.note.trim() ? { note: form.note.trim() } : {}),
          },
        }),
      `${CASUALTY_KINDS[form.kind]} count recorded.`,
    ).then((ok) => ok && setForm(blank));
  };
  return (
    <section aria-labelledby="decl-casualties">
      <h2 id="decl-casualties">Casualties</h2>
      <p>
        Official counts only, each with its source. Every entry is kept; a correction is a new
        entry, and the latest one is shown.
      </p>
      <DataTable
        caption="Current official casualty counts"
        rows={kinds}
        rowKey={(k) => k}
        columns={[
          { key: 'kind', header: 'Kind', render: (k) => CASUALTY_KINDS[k] },
          {
            key: 'count',
            header: 'Count',
            render: (k) =>
              view.casualties[k] ? n(view.casualties[k].count) : 'No official count yet',
          },
          {
            key: 'source',
            header: 'Official source',
            render: (k) => view.casualties[k]?.officialSource ?? '—',
          },
          { key: 'asOf', header: 'As of', render: (k) => fmt(view.casualties[k]?.asOf) },
          { key: 'entries', header: 'Entries', render: (k) => n(view.casualties[k]?.entries ?? 0) },
        ]}
      />
      {editable ? (
        <form onSubmit={add} className="form-grid" aria-labelledby="decl-cas-add">
          <h3 id="decl-cas-add">Record an official count</h3>
          <Field label="Kind">
            {({ id }) => (
              <select
                id={id}
                value={form.kind}
                onChange={(e) => setForm({ ...form, kind: e.target.value as CasualtyKind })}
              >
                {kinds.map((k) => (
                  <option key={k} value={k}>
                    {CASUALTY_KINDS[k]}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <Field label="Count" {...(countError ? { error: countError } : {})}>
            {({ id, describedBy, invalid }) => (
              <input
                id={id}
                inputMode="numeric"
                required
                aria-describedby={describedBy}
                aria-invalid={invalid}
                value={form.count}
                onChange={(e) => setForm({ ...form, count: e.target.value })}
              />
            )}
          </Field>
          <Field label="Official source" hint="For example: the county medical examiner’s report.">
            {({ id, describedBy }) => (
              <input
                id={id}
                required
                minLength={3}
                maxLength={300}
                aria-describedby={describedBy}
                value={form.officialSource}
                onChange={(e) => setForm({ ...form, officialSource: e.target.value })}
              />
            )}
          </Field>
          <Field label="As of">
            {({ id }) => (
              <input
                id={id}
                type="datetime-local"
                required
                value={form.asOf}
                onChange={(e) => setForm({ ...form, asOf: e.target.value })}
              />
            )}
          </Field>
          <Field label="Note (optional)" hint="No names.">
            {({ id, describedBy }) => (
              <input
                id={id}
                maxLength={1000}
                aria-describedby={describedBy}
                value={form.note}
                onChange={(e) => setForm({ ...form, note: e.target.value })}
              />
            )}
          </Field>
          <div className="toolbar">
            <button type="submit" className="primary">
              Record count
            </button>
          </div>
        </form>
      ) : null}
    </section>
  );
}

export function PublicDamage({
  view,
  sites,
  editable,
  run,
}: {
  view: View;
  /** Null when the sites are not shown (the state liaison sees category totals only). */
  sites: PaSite[] | null;
  editable: boolean;
  run: Run;
}) {
  const pa = view.publicAssistance;
  const ind = pa.indicators;
  const blank = {
    applicant: '',
    name: '',
    category: 'A' as Category,
    estimatedCost: '',
    costBasis: 'estimate' as 'estimate' | 'verified',
    percentComplete: '',
    insured: 'unknown',
    otherFederalAgency: 'unknown',
    debrisCubicYards: '',
  };
  const [form, setForm] = useState(blank);
  const num = (v: string, max: number, int = false) => {
    const t = v.trim();
    if (!t) return { value: null, error: undefined };
    const x = Number(t.replace(/,/g, ''));
    return Number.isFinite(x) && x >= 0 && x <= max && (!int || Number.isInteger(x))
      ? { value: x, error: undefined }
      : {
          value: null,
          error: int ? `Enter a whole number from 0 to ${max}.` : 'Enter an amount of 0 or more.',
        };
  };
  const cost = num(form.estimatedCost, 1e12);
  const done = num(form.percentComplete, 100, true);
  const debris = num(form.debrisCubicYards, 1e9);
  const add = (e: FormEvent) => {
    e.preventDefault();
    if (cost.error || done.error || debris.error) return;
    void run(
      () =>
        api(`/events/${view.eventId}/pa-sites`, {
          body: {
            clientUuid: crypto.randomUUID(),
            applicant: form.applicant.trim(),
            name: form.name.trim(),
            category: form.category,
            estimatedCost: cost.value,
            costBasis: form.costBasis,
            percentComplete: done.value,
            insured: form.insured,
            otherFederalAgency: form.otherFederalAgency,
            debrisCubicYards: debris.value,
          },
        }),
      `${form.name.trim()} added.`,
    ).then((ok) => ok && setForm(blank));
  };
  const meets = (m: boolean | null) =>
    m === null ? 'cannot be compared yet' : m ? 'meets it' : 'is below it';
  return (
    <section aria-labelledby="decl-pa">
      <h2 id="decl-pa">Public damage (Public Assistance)</h2>
      <p>
        {pa.sites} {pa.sites === 1 ? 'site' : 'sites'}, {usd(pa.totalCost)} in all (
        {usd(pa.verifiedCost)} verified).{' '}
        {ind.countyThreshold !== null
          ? `The countywide indicator is ${usd(ind.countyThreshold)} (${usd(ind.countywidePerCapita)} per person); the total ${meets(ind.meetsCounty)}.`
          : 'The countywide indicator is unknown until the per-person figure and the county population are both loaded.'}{' '}
        {ind.stateThreshold !== null
          ? `The statewide indicator is ${usd(ind.stateThreshold)}; the total ${meets(ind.meetsState)}.`
          : 'The statewide indicator is unknown until its per-person figure and the state population are entered.'}
        {ind.fiscalYear ? ` Indicators for federal fiscal year ${ind.fiscalYear}.` : ''}
      </p>
      <DataTable
        caption="Public damage by category of work"
        rows={Object.keys(CATEGORIES) as Category[]}
        rowKey={(c) => c}
        columns={[
          { key: 'cat', header: 'Category', render: (c) => CATEGORIES[c] },
          { key: 'sites', header: 'Sites', render: (c) => n(pa.byCategory[c].sites) },
          { key: 'cost', header: 'Cost', render: (c) => usd(pa.byCategory[c].cost) },
        ]}
      />
      {sites ? (
        <DataTable
          caption="Public damage sites"
          rows={sites}
          rowKey={(s) => s.id}
          empty="No public damage sites for this event."
          columns={[
            { key: 'name', header: 'Site', render: (s) => `${s.name} (${s.applicant})` },
            { key: 'cat', header: 'Category', render: (s) => s.category },
            {
              key: 'cost',
              header: 'Cost',
              render: (s) =>
                `${usd(s.estimatedCost)}${s.estimatedCost !== null ? (s.costBasis === 'verified' ? ', verified' : ', estimate') : ''}`,
            },
            {
              key: 'done',
              header: 'Complete',
              render: (s) => (s.percentComplete === null ? 'Unknown' : `${s.percentComplete}%`),
            },
            { key: 'ins', header: 'Insured', render: (s) => YNU[s.insured] ?? s.insured },
            {
              key: 'ofa',
              header: 'Other federal agency',
              render: (s) => YNU[s.otherFederalAgency] ?? s.otherFederalAgency,
            },
            { key: 'photos', header: 'Photos', render: (s) => n(s.photos) },
            {
              key: 'status',
              header: 'Status',
              render: (s) =>
                s.status === 'withdrawn' ? (
                  'Withdrawn'
                ) : editable ? (
                  <button
                    type="button"
                    onClick={() =>
                      void run(
                        () =>
                          api(`/pa-sites/${s.id}`, {
                            method: 'PATCH',
                            version: s.version,
                            body: { status: 'withdrawn' },
                          }),
                        `${s.name} withdrawn.`,
                      )
                    }
                  >
                    Withdraw {s.name}
                  </button>
                ) : (
                  'Active'
                ),
            },
          ]}
        />
      ) : null}
      {editable ? (
        <form onSubmit={add} className="form-grid" aria-labelledby="decl-pa-add">
          <h3 id="decl-pa-add">Add a public damage site</h3>
          <Field label="Applicant" hint="The public body or eligible nonprofit that owns the site.">
            {({ id, describedBy }) => (
              <input
                id={id}
                required
                maxLength={200}
                aria-describedby={describedBy}
                value={form.applicant}
                onChange={(e) => setForm({ ...form, applicant: e.target.value })}
              />
            )}
          </Field>
          <Field label="Site name">
            {({ id }) => (
              <input
                id={id}
                required
                maxLength={200}
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
              />
            )}
          </Field>
          <Field label="Category of work">
            {({ id }) => (
              <select
                id={id}
                value={form.category}
                onChange={(e) => setForm({ ...form, category: e.target.value as Category })}
              >
                {(Object.keys(CATEGORIES) as Category[]).map((c) => (
                  <option key={c} value={c}>
                    {CATEGORIES[c]}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <Field
            label="Cost in US dollars (optional)"
            {...(cost.error ? { error: cost.error } : {})}
          >
            {({ id, describedBy, invalid }) => (
              <input
                id={id}
                inputMode="decimal"
                aria-describedby={describedBy}
                aria-invalid={invalid}
                value={form.estimatedCost}
                onChange={(e) => setForm({ ...form, estimatedCost: e.target.value })}
              />
            )}
          </Field>
          <Field label="Cost basis">
            {({ id }) => (
              <select
                id={id}
                value={form.costBasis}
                onChange={(e) =>
                  setForm({ ...form, costBasis: e.target.value as 'estimate' | 'verified' })
                }
              >
                <option value="estimate">Estimate</option>
                <option value="verified">Verified</option>
              </select>
            )}
          </Field>
          <Field label="Percent complete (optional)" {...(done.error ? { error: done.error } : {})}>
            {({ id, describedBy, invalid }) => (
              <input
                id={id}
                inputMode="numeric"
                aria-describedby={describedBy}
                aria-invalid={invalid}
                value={form.percentComplete}
                onChange={(e) => setForm({ ...form, percentComplete: e.target.value })}
              />
            )}
          </Field>
          <Field label="Insured">
            {({ id }) => (
              <select
                id={id}
                value={form.insured}
                onChange={(e) => setForm({ ...form, insured: e.target.value })}
              >
                {Object.entries(YNU).map(([v, l]) => (
                  <option key={v} value={v}>
                    {l}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <Field label="Another federal agency responsible">
            {({ id }) => (
              <select
                id={id}
                value={form.otherFederalAgency}
                onChange={(e) => setForm({ ...form, otherFederalAgency: e.target.value })}
              >
                {Object.entries(YNU).map(([v, l]) => (
                  <option key={v} value={v}>
                    {l}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <Field
            label="Debris in cubic yards (optional)"
            {...(debris.error ? { error: debris.error } : {})}
          >
            {({ id, describedBy, invalid }) => (
              <input
                id={id}
                inputMode="decimal"
                aria-describedby={describedBy}
                aria-invalid={invalid}
                value={form.debrisCubicYards}
                onChange={(e) => setForm({ ...form, debrisCubicYards: e.target.value })}
              />
            )}
          </Field>
          <div className="toolbar">
            <button type="submit" className="primary">
              Add site
            </button>
          </div>
        </form>
      ) : null}
    </section>
  );
}

export function Donated({ view }: { view: View }) {
  const d = view.donated;
  return (
    <section aria-labelledby="decl-donated">
      <h2 id="decl-donated">Volunteer hours donated</h2>
      <p>
        {d.volunteerHours.toLocaleString('en-US')} hours from partner organizations and registered
        volunteers, from check-ins; county staff hours are not included.
        {d.includesOpenShifts ? ' Shifts still open are counted up to now.' : ''}
      </p>
      <DataTable
        caption="Donated hours by organization"
        rows={d.byOrganization}
        rowKey={(r) => r.organization}
        empty="No donated hours recorded for this event."
        columns={[
          { key: 'org', header: 'Organization', render: (r) => r.organization },
          { key: 'people', header: 'People', render: (r) => n(r.people) },
          { key: 'hours', header: 'Hours', render: (r) => n(r.hours) },
        ]}
      />
      {d.equipment ? (
        <>
          <h3>Donated equipment</h3>
          <p className="hint">
            The equipment each partner team brought, with the team&apos;s hours on duty. Whether an
            item was in use for all of them is for the county to confirm before a claim.
          </p>
          <DataTable
            caption="Donated equipment by team"
            rows={d.equipment}
            rowKey={(r) => `${r.team}|${r.item}`}
            empty="No partner team has recorded equipment for this event."
            columns={[
              { key: 'org', header: 'Organization', render: (r) => r.organization },
              { key: 'team', header: 'Team', render: (r) => r.team },
              { key: 'item', header: 'Equipment', render: (r) => r.item },
              { key: 'hours', header: 'Hours on duty', render: (r) => n(r.hours) },
            ]}
          />
        </>
      ) : null}
    </section>
  );
}

/**
 * DCL:DEC-09: resources committed by partner organizations, counts only, from their own records;
 * all of them, or the organizations and categories the county chose (2026-10-15).
 */
export function Partners({
  view,
  editable = false,
  run,
}: {
  view: View;
  editable?: boolean;
  run?: Run;
}) {
  const p = view.partners;
  if (!p) return null;
  const t = p.totals;
  /** A category the county left out reads as not included, never as zero. */
  const inc = (v: number | null | undefined) => (v === null ? 'not included' : n(v));
  const sv = (r: { services: Record<string, number> | null }, k: string) =>
    r.services === null ? 'not included' : n(r.services[k] ?? 0);
  const rollup = p.rollup;
  return (
    <section aria-labelledby="decl-partners">
      <h2 id="decl-partners">Resources committed by partners</h2>
      <p>
        From partner organizations’ own records: needs met {inc(t.needsMet)}; meals {inc(t.meals)};
        cases of water {inc(t.waterCases)}; tarps {inc(t.tarps)}; cots {inc(t.cots)}; rides{' '}
        {inc(t.rides)}; people sheltered {inc(t.shelteredPeople)} in {inc(t.shelteredHouseholds)}{' '}
        households; teams {inc(t.teams)}.
      </p>
      <p className="hint">
        Numbers only: no name, household or record leaves a partner organization.
      </p>
      {rollup ? (
        <PartnerRollupChooser
          key={`${view.declaration?.version ?? 0}`}
          id="decl-rollup"
          value={{
            all: rollup.all,
            partners: rollup.partners.map((x) => x.id),
            categories: rollup.categories,
          }}
          organizations={p.organizations ?? []}
          statement={rollup.statement}
          editable={editable && !!run}
          onSave={(choice) =>
            run!(
              () =>
                api(`/events/${view.eventId}/declaration`, {
                  method: 'PUT',
                  body: { partnerRollup: choice },
                  ...(view.declaration ? { version: view.declaration.version } : {}),
                }),
              'Partner counts choice saved.',
            )
          }
        />
      ) : null}
      <DataTable
        caption="Resources committed by organization"
        rows={p.byOrganization}
        rowKey={(r) => r.id ?? r.organization}
        empty="No partner organization is included, or none has recorded work for this event yet."
        columns={[
          { key: 'org', header: 'Organization', render: (r) => r.organization },
          { key: 'needs', header: 'Needs met', render: (r) => inc(r.needsMet) },
          { key: 'meals', header: 'Meals', render: (r) => sv(r, 'meal') },
          { key: 'water', header: 'Water (cases)', render: (r) => sv(r, 'water_case') },
          { key: 'tarps', header: 'Tarps', render: (r) => sv(r, 'tarp') },
          { key: 'served', header: 'People served', render: (r) => sv(r, 'person_served') },
          {
            key: 'sheltered',
            header: 'Sheltered',
            render: (r) =>
              r.shelteredPeople === null
                ? 'not included'
                : `${n(r.shelteredPeople)} people, ${n(r.shelteredHouseholds)} households`,
          },
          { key: 'teams', header: 'Teams', render: (r) => inc(r.teams) },
        ]}
      />
    </section>
  );
}
