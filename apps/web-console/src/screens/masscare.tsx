/**
 * Shelters and volunteer reception in the console (layer-4 plan console 8
 * and 9; CON-16, FL:FR-14, FL:FR-15, FL:FR-20, PER-01, BDG-01, RULE-11,
 * ADM-05 G7, SEC-10):
 *
 * - Shelters: for county shelters and those a partner runs. The owner names
 *   the partner that operates a site; the operator registers households
 *   (cots, needs, pets; access needs only for roles that may see them), hands
 *   over wristband codes, checks guests out, keeps the quiet incident log,
 *   and sends the census to the county as the site's confirmed occupancy.
 * - Volunteer reception: a walk-up volunteer registered in one step with the
 *   signed waiver, skills (recorded, not verified), the background-check
 *   status only, a team, a check-in and a badge whose code is shown once.
 *   Walk-ups can also sign up on their own phones through a code reception
 *   opens for the event (FL:FR-20); their requests wait at the desk under a
 *   desk code, and reception completes or declines each one. Reception sees
 *   whether a phone or email was given, never the contact itself.
 */
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { api, describeFailure } from '../api/client.ts';
import { DataTable, Field, Status, Toolbar, fmt } from '../ui/primitives.tsx';
import { QrImage } from '../ui/qr.tsx';
import { EventPicker, useOpenEvents } from './dispatch.tsx';

const label = (s: string | null | undefined) => (s ? s.replace(/_/g, ' ') : '—');

function useApi<T>(path: string | null) {
  const [state, setState] = useState<{ data: T | null; error: string | null }>({
    data: null,
    error: null,
  });
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!path) return;
    let live = true;
    api<T>(path)
      .then((data) => live && setState({ data, error: null }))
      .catch(
        (e: unknown) => live && setState((s) => ({ data: s.data, error: describeFailure(e) })),
      );
    return () => {
      live = false;
    };
  }, [path, tick]);
  return { ...state, reload: () => setTick((n) => n + 1) };
}

interface Site {
  id: string;
  version: number;
  name: string;
  kind: string;
  status: string;
  capacity: number | null;
  occupancy: number | null;
  operatorTenantId: string | null;
  lastConfirmedAt: string | null;
}
interface Tenant {
  id: string;
  kind: string;
  name: string;
}
interface Stay {
  id: string;
  householdName: string | null;
  householdSize: number;
  adults: number;
  children: number;
  cots: string[];
  dietaryNeeds: string | null;
  accessNeeds: string | null;
  pets: number;
  checkedInAt: string;
}
interface Census {
  households: number;
  people: number;
  children: number;
  pets: number;
  cotsInUse: string[];
}

export function SheltersScreen({ me }: { me: { tenantId: string } | null }) {
  const { events } = useOpenEvents();
  const [eventId, setEventId] = useState<string | null>(null);
  const currentEvent = eventId ?? events?.[0]?.id ?? null;
  const sites = useApi<Site[]>('/sites?kind=shelter&limit=200');
  const partners = useApi<Tenant[]>('/tenants?limit=200');
  const [siteId, setSiteId] = useState<string | null>(null);
  const current = sites.data?.find((s) => s.id === siteId) ?? sites.data?.[0] ?? null;
  const census = useApi<Census>(
    current ? `/field-records/shelter_stay/census?siteId=${current.id}` : null,
  );
  const stays = useApi<Stay[]>(
    current ? `/field-records/shelter_stay?siteId=${current.id}&open=true&limit=200` : null,
  );
  const incidents = useApi<
    { id: string; kind: string; summary: string | null; occurredAt: string }[]
  >(current ? `/field-records/shelter_incident?siteId=${current.id}&limit=50` : null);
  const [f, setF] = useState({
    name: '',
    adults: 1,
    children: 0,
    pets: 0,
    cots: '',
    diet: '',
    access: '',
  });
  const [incident, setIncident] = useState({ kind: 'facility', summary: '' });
  const [band, setBand] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);
  // The operator never re-assigns a site; the owner does (the server checks site.edit).
  const owner = !!current && !!me && current.operatorTenantId !== me.tenantId;
  const run = async (fn: () => Promise<unknown>, ok: string) => {
    try {
      await fn();
      setMsg({ kind: 'success', text: ok });
    } catch (e) {
      setMsg({ kind: 'error', text: describeFailure(e) });
    }
    sites.reload();
    census.reload();
    stays.reload();
    incidents.reload();
  };
  const register = async (e: FormEvent) => {
    e.preventDefault();
    if (!current) return;
    try {
      const r = await api<{ wristbandCode: string }>('/field-records/shelter_stay', {
        body: {
          clientUuid: crypto.randomUUID(),
          siteId: current.id,
          householdSize: f.adults + f.children,
          adults: f.adults,
          children: f.children,
          pets: f.pets,
          cots: f.cots.split(/[,\s]+/).filter(Boolean),
          ...(currentEvent ? { eventId: currentEvent } : {}),
          ...(f.name.trim() ? { householdName: f.name.trim() } : {}),
          ...(f.diet.trim() ? { dietaryNeeds: f.diet.trim() } : {}),
          ...(f.access.trim() ? { accessNeeds: f.access.trim() } : {}),
        },
      });
      setBand(r.wristbandCode);
      setMsg({
        kind: 'success',
        text: 'Registered. Write the wristband code on the band now; it is shown only once.',
      });
      setF({ name: '', adults: 1, children: 0, pets: 0, cots: '', diet: '', access: '' });
      census.reload();
      stays.reload();
    } catch (err) {
      setMsg({ kind: 'error', text: describeFailure(err) });
    }
  };
  const num = (k: 'adults' | 'children' | 'pets', lbl: string) => (
    <Field label={lbl}>
      {({ id }) => (
        <input
          id={id}
          type="number"
          min={0}
          max={30}
          value={f[k]}
          onChange={(e) => setF({ ...f, [k]: Number(e.target.value) })}
        />
      )}
    </Field>
  );
  return (
    <section aria-labelledby="shelters-h">
      <h1 id="shelters-h">Shelters</h1>
      <Toolbar>
        {events?.length ? (
          <EventPicker events={events} value={currentEvent} onChange={setEventId} />
        ) : null}
        <label className="inline">
          Shelter
          <select value={current?.id ?? ''} onChange={(e) => setSiteId(e.target.value)}>
            {(sites.data ?? []).map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </label>
      </Toolbar>
      {msg ? <Status kind={msg.kind}>{msg.text}</Status> : null}
      {sites.error ? <Status kind="error">{sites.error}</Status> : null}
      {sites.data?.length === 0 ? <p>No shelters you can see.</p> : null}
      {current ? (
        <>
          <dl className="meta">
            <dt>Status</dt>
            <dd>{label(current.status)}</dd>
            <dt>Occupancy confirmed</dt>
            <dd>
              {current.occupancy ?? '—'} of {current.capacity ?? '—'} ·{' '}
              {fmt(current.lastConfirmedAt)}
            </dd>
            <dt>Run by</dt>
            <dd>
              {current.operatorTenantId
                ? (partners.data?.find((t) => t.id === current.operatorTenantId)?.name ??
                  'A partner organization')
                : 'This organization'}
            </dd>
          </dl>
          {owner ? (
            <label className="inline">
              Partner that runs this shelter
              <select
                value={current.operatorTenantId ?? ''}
                onChange={(e) =>
                  void run(
                    () =>
                      api(`/sites/${current.id}`, {
                        method: 'PATCH',
                        body: { operatorTenantId: e.target.value || null },
                        version: current.version,
                      }),
                    'Operator updated.',
                  )
                }
              >
                <option value="">None (run by the owner)</option>
                {(partners.data ?? [])
                  .filter((t) => t.kind === 'partner_org')
                  .map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
              </select>
            </label>
          ) : null}
          <h2>Census</h2>
          {census.data ? (
            <p role="status">
              Households {census.data.households} · People {census.data.people} · Children{' '}
              {census.data.children} · Pets {census.data.pets} · Cots in use{' '}
              {census.data.cotsInUse.length}
            </p>
          ) : (
            <p className="hint">
              The census counts the households your organization registered here.
            </p>
          )}
          {census.data ? (
            <button
              type="button"
              onClick={() =>
                void run(
                  () =>
                    api(`/sites/${current.id}/confirm`, {
                      body: {
                        occupancy: census.data!.people,
                        status:
                          current.capacity !== null && census.data!.people >= current.capacity
                            ? 'full'
                            : current.status,
                        note: 'Census from shelter registrations',
                      },
                    }),
                  'Census sent: the site’s occupancy is confirmed.',
                )
              }
            >
              Send this census to the county ({census.data.people} people)
            </button>
          ) : null}
          {band ? (
            <p className="panel">
              Wristband code: <strong>{band}</strong>
            </p>
          ) : null}
          <form className="panel" onSubmit={(e) => void register(e)} aria-labelledby="reg-h">
            <h2 id="reg-h">Register a household</h2>
            <div className="form-grid">
              <Field label="Household name (optional, private)">
                {({ id }) => (
                  <input
                    id={id}
                    value={f.name}
                    onChange={(e) => setF({ ...f, name: e.target.value })}
                  />
                )}
              </Field>
              {num('adults', 'Adults')}
              {num('children', 'Children')}
              {num('pets', 'Pets')}
              <Field label="Cots" hint="For example: C-12, C-13">
                {({ id, describedBy }) => (
                  <input
                    id={id}
                    aria-describedby={describedBy}
                    value={f.cots}
                    onChange={(e) => setF({ ...f, cots: e.target.value })}
                  />
                )}
              </Field>
              <Field label="Dietary needs (optional)">
                {({ id }) => (
                  <input
                    id={id}
                    value={f.diet}
                    onChange={(e) => setF({ ...f, diet: e.target.value })}
                  />
                )}
              </Field>
            </div>
            <Field
              label="Access or medical needs (optional)"
              hint="Private: only shelter staff and health roles see it."
            >
              {({ id, describedBy }) => (
                <textarea
                  id={id}
                  aria-describedby={describedBy}
                  rows={2}
                  value={f.access}
                  onChange={(e) => setF({ ...f, access: e.target.value })}
                />
              )}
            </Field>
            <button type="submit" className="primary" disabled={f.adults + f.children < 1}>
              Register and show the wristband code
            </button>
          </form>
          <h2>Guests now</h2>
          <DataTable
            caption="Households checked in"
            rows={stays.data ?? []}
            rowKey={(s) => s.id}
            empty="No households registered here by your organization."
            columns={[
              { key: 'n', header: 'Household', render: (s) => s.householdName ?? 'No name given' },
              {
                key: 'p',
                header: 'People',
                render: (s) => `${s.householdSize} (${s.children} children)`,
              },
              { key: 'c', header: 'Cots', render: (s) => s.cots.join(', ') || '—' },
              {
                key: 'a',
                header: 'Needs',
                render: (s) => [s.dietaryNeeds, s.accessNeeds].filter(Boolean).join('; ') || '—',
              },
              { key: 't', header: 'Since', render: (s) => fmt(s.checkedInAt) },
              {
                key: 'x',
                header: 'Action',
                render: (s) => (
                  <button
                    type="button"
                    onClick={() =>
                      void run(
                        () => api(`/field-records/shelter_stay/${s.id}/check-out`, { body: {} }),
                        'Checked out.',
                      )
                    }
                  >
                    Check out {s.householdName ?? 'this household'}
                  </button>
                ),
              },
            ]}
          />
          <h2>Quiet incident log</h2>
          <form
            className="panel"
            onSubmit={(e) => {
              e.preventDefault();
              void run(
                () =>
                  api('/field-records/shelter_incident', {
                    body: {
                      clientUuid: crypto.randomUUID(),
                      siteId: current.id,
                      kind: incident.kind,
                      summary: incident.summary.trim(),
                    },
                  }),
                'Logged privately.',
              ).then(() => setIncident({ ...incident, summary: '' }));
            }}
          >
            <p className="hint">Private to the shelter lead. Not a substitute for 911.</p>
            <div className="form-grid">
              <Field label="Kind">
                {({ id }) => (
                  <select
                    id={id}
                    value={incident.kind}
                    onChange={(e) => setIncident({ ...incident, kind: e.target.value })}
                  >
                    {['medical', 'behavioral', 'safety', 'security', 'facility', 'other'].map(
                      (k) => (
                        <option key={k} value={k}>
                          {label(k)}
                        </option>
                      ),
                    )}
                  </select>
                )}
              </Field>
            </div>
            <Field label="What happened">
              {({ id }) => (
                <textarea
                  id={id}
                  rows={2}
                  value={incident.summary}
                  onChange={(e) => setIncident({ ...incident, summary: e.target.value })}
                />
              )}
            </Field>
            <button type="submit" disabled={incident.summary.trim().length < 3}>
              Add to the log
            </button>
          </form>
          {incidents.data ? (
            <DataTable
              caption="Incidents"
              rows={incidents.data}
              rowKey={(i) => i.id}
              empty="No incidents logged."
              columns={[
                { key: 't', header: 'When', render: (i) => fmt(i.occurredAt) },
                { key: 'k', header: 'Kind', render: (i) => label(i.kind) },
                { key: 's', header: 'What happened', render: (i) => i.summary ?? '—' },
              ]}
            />
          ) : (
            <p className="hint">Your role does not read the incident log.</p>
          )}
        </>
      ) : null}
    </section>
  );
}

// -------------------------------------------------------------- reception
const SKILLS = [
  'chainsaw',
  'spanish_speaker',
  'cert',
  'ham_operator',
  'medical',
  'driver_cdl',
  'heavy_equipment',
  'shelter_management',
  'food_safety',
  'child_safeguarding',
  'mental_health_first_aid',
];
interface Registration {
  id: string;
  version: number;
  name: string | null;
  skills: string[];
  backgroundCheckStatus: string;
  assignedTeamId: string | null;
  registeredAt: string;
  waiverVersion: string | null;
  badgeCode?: string;
}
/** FL:FR-20: a walk-up's own sign-up waiting at the desk; never the contact itself. */
interface Signup {
  id: string;
  version: number;
  deskCode: string;
  name: string;
  agency: string | null;
  gavePhone: boolean;
  gaveEmail: boolean;
  skills: string[];
  waiverVersion: string;
  waiverAcceptedAt: string | null;
  createdAt: string;
}
interface SignupLink {
  id: string;
  waiverVersion: string;
  waiverLanguages: string[];
  expiresAt: string;
  waiting: number;
  url?: string;
}

/**
 * FL:FR-20: reception opens a sign-up code for the event (shown once: print it
 * or keep the page open), sees the requests waiting at the desk and takes each
 * one into the registration form, or declines it.
 */
function SignupDesk({
  eventId,
  waiverVersion,
  signups,
  reload,
  onTake,
  onMessage,
}: {
  eventId: string;
  waiverVersion: string;
  signups: Signup[];
  reload: () => void;
  onTake: (s: Signup) => void;
  onMessage: (m: { kind: 'success' | 'error'; text: string }) => void;
}) {
  const links = useApi<SignupLink[]>(`/volunteer-signup-links?eventId=${eventId}`);
  const [opened, setOpened] = useState<SignupLink | null>(null);
  const [form, setForm] = useState({ en: '', es: '', hours: 12 });
  const open = async (e: FormEvent) => {
    e.preventDefault();
    try {
      const link = await api<SignupLink>('/volunteer-signup-links', {
        body: {
          eventId,
          waiverVersion,
          waiverText: {
            ...(form.en.trim() ? { en: form.en.trim() } : {}),
            ...(form.es.trim() ? { es: form.es.trim() } : {}),
          },
          hours: form.hours,
        },
      });
      setOpened(link);
      links.reload();
      onMessage({ kind: 'success', text: 'The sign-up code is open.' });
    } catch (err) {
      onMessage({ kind: 'error', text: describeFailure(err) });
    }
  };
  const close = async (id: string) => {
    try {
      await api(`/volunteer-signup-links/${id}/close`, { method: 'POST' });
      if (opened?.id === id) setOpened(null);
      links.reload();
      onMessage({ kind: 'success', text: 'The sign-up code is closed.' });
    } catch (err) {
      onMessage({ kind: 'error', text: describeFailure(err) });
    }
  };
  const decline = async (r: Signup) => {
    try {
      await api(`/volunteer-signups/${r.id}/decline`, { method: 'POST', version: r.version });
      onMessage({
        kind: 'success',
        text: `The request with desk code ${r.deskCode} was declined.`,
      });
    } catch (err) {
      onMessage({ kind: 'error', text: describeFailure(err) });
    }
    reload();
  };
  return (
    <section className="panel" aria-labelledby="signup-h">
      <h2 id="signup-h">Sign-up by QR at the desk</h2>
      <p>
        Volunteers scan the code with their own phone and get a desk code. Their details wait here
        until you register them below or decline.
      </p>
      {opened?.url ? (
        <div className="signup-code">
          <QrImage text={opened.url} alt="Code that opens the volunteer sign-up" size={200} />
          <p>
            <span className="url">{opened.url}</span>
          </p>
          <p className="hint">
            Shown once: print this page or keep it open. Open a new code if you lose it.
          </p>
          <button type="button" onClick={() => window.print()}>
            Print the code
          </button>
        </div>
      ) : null}
      <form onSubmit={(e) => void open(e)} aria-labelledby="signup-open-h">
        <h3 id="signup-open-h">Open a sign-up code</h3>
        <Field
          label="Waiver text in English (optional)"
          hint={`Volunteers read and accept it on their phone. Leave both blank to have them sign the waiver (${waiverVersion}) at the desk.`}
        >
          {({ id, describedBy }) => (
            <textarea
              id={id}
              aria-describedby={describedBy}
              rows={4}
              value={form.en}
              onChange={(e) => setForm({ ...form, en: e.target.value })}
            />
          )}
        </Field>
        <Field label="Waiver text in Spanish (optional)">
          {({ id }) => (
            <textarea
              id={id}
              lang="es"
              rows={4}
              value={form.es}
              onChange={(e) => setForm({ ...form, es: e.target.value })}
            />
          )}
        </Field>
        <Field label="Open for (hours)">
          {({ id }) => (
            <input
              id={id}
              type="number"
              min={1}
              max={72}
              value={form.hours}
              onChange={(e) => setForm({ ...form, hours: Number(e.target.value) || 12 })}
            />
          )}
        </Field>
        <button type="submit">Open a sign-up code</button>
      </form>
      <DataTable
        caption="Open sign-up codes"
        rows={links.data ?? []}
        rowKey={(r) => r.id}
        empty="No sign-up code is open for this event."
        columns={[
          { key: 'e', header: 'Open until', render: (r) => fmt(r.expiresAt) },
          {
            key: 'w',
            header: 'Waiver',
            render: (r) =>
              r.waiverLanguages.length
                ? `${r.waiverVersion}, read on the phone (${r.waiverLanguages.join(', ')})`
                : `${r.waiverVersion}, signed at the desk`,
          },
          { key: 'n', header: 'Waiting', render: (r) => String(r.waiting) },
          {
            key: 'c',
            header: 'Close',
            render: (r) => (
              <button type="button" onClick={() => void close(r.id)}>
                Close the code open until {fmt(r.expiresAt)}
              </button>
            ),
          },
        ]}
      />
      <DataTable
        caption="Waiting at the desk"
        rows={signups}
        rowKey={(r) => r.id}
        empty="Nobody is waiting at the desk."
        columns={[
          { key: 'd', header: 'Desk code', render: (r) => <strong>{r.deskCode}</strong> },
          { key: 'n', header: 'Name', render: (r) => r.name },
          { key: 'o', header: 'Organization', render: (r) => r.agency ?? '—' },
          {
            key: 's',
            header: 'Skills (unverified)',
            render: (r) => r.skills.map(label).join(', ') || '—',
          },
          {
            key: 'w',
            header: 'Waiver',
            render: (r) =>
              r.waiverAcceptedAt
                ? `Accepted on the phone (${r.waiverVersion})`
                : 'Sign at the desk',
          },
          {
            key: 'r',
            header: 'Reach them',
            render: (r) =>
              [r.gavePhone ? 'phone' : null, r.gaveEmail ? 'email' : null]
                .filter(Boolean)
                .join(' and ') || 'none given',
          },
          { key: 't', header: 'Signed up', render: (r) => fmt(r.createdAt) },
          {
            key: 'a',
            header: 'Action',
            render: (r) => (
              <>
                <button type="button" onClick={() => onTake(r)}>
                  Register {r.deskCode}
                </button>{' '}
                <button type="button" onClick={() => void decline(r)}>
                  Decline {r.deskCode}
                </button>
              </>
            ),
          },
        ]}
      />
    </section>
  );
}

export function VolunteerReceptionScreen() {
  const { events } = useOpenEvents();
  const [eventId, setEventId] = useState<string | null>(null);
  const currentEvent = eventId ?? events?.[0]?.id ?? null;
  const list = useApi<Registration[]>(
    currentEvent ? `/volunteer-registrations?eventId=${currentEvent}&limit=100` : null,
  );
  const teams = useApi<{ id: string; name: string }[]>(
    currentEvent ? `/teams?eventId=${currentEvent}&limit=200` : null,
  );
  const [f, setF] = useState({
    name: '',
    phone: '',
    email: '',
    agency: '',
    skills: [] as string[],
    waiver: false,
    waiverVersion: 'county-volunteer-waiver-2026',
    check: 'not_required',
    team: '',
    checkIn: true,
    badge: true,
  });
  const [done, setDone] = useState<Registration | null>(null);
  const [msg, setMsg] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);
  // FL:FR-20: the desk request this registration completes, if any.
  const [fromSignup, setFromSignup] = useState<Signup | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const signups = useApi<Signup[]>(
    currentEvent ? `/volunteer-signups?eventId=${currentEvent}` : null,
  );
  const takeSignup = (r: Signup) => {
    setFromSignup(r);
    setF({
      ...f,
      name: r.name,
      agency: r.agency ?? '',
      phone: '',
      email: '',
      skills: r.skills,
      waiver: r.waiverAcceptedAt !== null,
      waiverVersion: r.waiverVersion,
    });
    setMsg(null);
    nameRef.current?.focus();
  };
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!currentEvent) return;
    try {
      const r = await api<Registration>('/volunteer-registrations', {
        body: {
          clientUuid: crypto.randomUUID(),
          eventId: currentEvent,
          ...(fromSignup ? { signupId: fromSignup.id } : {}),
          person: {
            name: f.name.trim(),
            ...(f.agency.trim() ? { agency: f.agency.trim() } : {}),
            ...(f.phone.trim() ? { phone: f.phone.trim() } : {}),
            ...(f.email.trim() ? { email: f.email.trim() } : {}),
          },
          skills: f.skills,
          waiverSigned: true,
          waiverVersion: f.waiverVersion,
          backgroundCheckStatus: f.check,
          checkIn: f.checkIn,
          ...(f.team ? { teamId: f.team } : {}),
          ...(f.badge ? { badge: { roleLabel: 'Volunteer' } } : {}),
        },
      });
      setDone(r);
      setMsg({
        kind: 'success',
        text: `${f.name.trim()} is registered${f.checkIn ? ' and checked in' : ''}.`,
      });
      setF({
        ...f,
        name: '',
        phone: '',
        email: '',
        agency: '',
        skills: [],
        waiver: false,
        team: '',
      });
      setFromSignup(null);
      list.reload();
      signups.reload();
    } catch (err) {
      setMsg({ kind: 'error', text: describeFailure(err) });
    }
  };
  return (
    <section aria-labelledby="rec-h">
      <h1 id="rec-h">Volunteer reception</h1>
      <Toolbar>
        {events?.length ? (
          <EventPicker events={events} value={currentEvent} onChange={setEventId} />
        ) : null}
      </Toolbar>
      {msg ? <Status kind={msg.kind}>{msg.text}</Status> : null}
      {done?.badgeCode ? (
        <p className="panel">
          Badge code (shown once): <strong>{done.badgeCode}</strong>. Print the badge from the
          Badges page.
        </p>
      ) : null}
      {currentEvent ? (
        <SignupDesk
          eventId={currentEvent}
          waiverVersion={f.waiverVersion}
          signups={signups.data ?? []}
          reload={signups.reload}
          onTake={takeSignup}
          onMessage={setMsg}
        />
      ) : null}
      <form className="panel" onSubmit={(e) => void submit(e)} aria-labelledby="walkup-reg-h">
        <h2 id="walkup-reg-h">Register a walk-up volunteer</h2>
        {fromSignup ? (
          <p>
            Completing the sign-up with desk code <strong>{fromSignup.deskCode}</strong>.{' '}
            {fromSignup.gavePhone || fromSignup.gaveEmail
              ? 'The phone or email they gave goes straight to the roster; type one only to replace it.'
              : 'They gave no phone or email.'}{' '}
            <button
              type="button"
              onClick={() => {
                setFromSignup(null);
                setF({ ...f, name: '', agency: '', skills: [], waiver: false });
              }}
            >
              Not this request
            </button>
          </p>
        ) : null}
        <div className="form-grid">
          <Field label="Full name">
            {({ id }) => (
              <input
                id={id}
                ref={nameRef}
                value={f.name}
                onChange={(e) => setF({ ...f, name: e.target.value })}
                required
              />
            )}
          </Field>
          <Field label="Phone (private)">
            {({ id }) => (
              <input
                id={id}
                type="tel"
                value={f.phone}
                onChange={(e) => setF({ ...f, phone: e.target.value })}
              />
            )}
          </Field>
          <Field label="Email (private)">
            {({ id }) => (
              <input
                id={id}
                type="email"
                value={f.email}
                onChange={(e) => setF({ ...f, email: e.target.value })}
              />
            )}
          </Field>
          <Field label="Organization (optional)">
            {({ id }) => (
              <input
                id={id}
                value={f.agency}
                onChange={(e) => setF({ ...f, agency: e.target.value })}
              />
            )}
          </Field>
          <Field label="Background check" hint="The status only. Never record what a check found.">
            {({ id, describedBy }) => (
              <select
                id={id}
                aria-describedby={describedBy}
                value={f.check}
                onChange={(e) => setF({ ...f, check: e.target.value })}
              >
                {['not_required', 'pending', 'cleared', 'not_cleared', 'expired'].map((c) => (
                  <option key={c} value={c}>
                    {label(c)}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <Field label="Team (optional)">
            {({ id }) => (
              <select id={id} value={f.team} onChange={(e) => setF({ ...f, team: e.target.value })}>
                <option value="">None yet</option>
                {(teams.data ?? []).map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </select>
            )}
          </Field>
        </div>
        <fieldset>
          <legend>Skills they say they have (verified later)</legend>
          {SKILLS.map((k) => (
            <label
              key={k}
              className="inline"
              style={{ flexDirection: 'row', alignItems: 'center', marginInlineEnd: '1rem' }}
            >
              <input
                type="checkbox"
                checked={f.skills.includes(k)}
                onChange={(e) =>
                  setF({
                    ...f,
                    skills: e.target.checked ? [...f.skills, k] : f.skills.filter((x) => x !== k),
                  })
                }
              />{' '}
              {label(k)}
            </label>
          ))}
        </fieldset>
        <label className="inline" style={{ flexDirection: 'row', alignItems: 'center' }}>
          <input
            type="checkbox"
            checked={f.waiver}
            onChange={(e) => setF({ ...f, waiver: e.target.checked })}
            required
          />{' '}
          {fromSignup?.waiverAcceptedAt
            ? `The volunteer accepted the waiver (${f.waiverVersion}) on their phone at ${fmt(fromSignup.waiverAcceptedAt)}`
            : `The volunteer read and signed the waiver (${f.waiverVersion})`}
        </label>
        <label className="inline" style={{ flexDirection: 'row', alignItems: 'center' }}>
          <input
            type="checkbox"
            checked={f.checkIn}
            onChange={(e) => setF({ ...f, checkIn: e.target.checked })}
          />{' '}
          Check them in now
        </label>
        <label className="inline" style={{ flexDirection: 'row', alignItems: 'center' }}>
          <input
            type="checkbox"
            checked={f.badge}
            onChange={(e) => setF({ ...f, badge: e.target.checked })}
          />{' '}
          Generate a badge
        </label>
        <button type="submit" className="primary" disabled={!f.name.trim() || !f.waiver}>
          Register
        </button>
      </form>
      <DataTable
        caption="Registered at reception"
        rows={list.data ?? []}
        rowKey={(r) => r.id}
        empty="Nobody registered at reception for this event yet."
        columns={[
          { key: 'n', header: 'Name', render: (r) => r.name ?? '—' },
          {
            key: 's',
            header: 'Skills (unverified)',
            render: (r) => r.skills.map(label).join(', ') || '—',
          },
          { key: 'w', header: 'Waiver', render: (r) => r.waiverVersion ?? '—' },
          {
            key: 'b',
            header: 'Background check',
            render: (r) => (
              <select
                aria-label={`Background check for ${r.name ?? 'this volunteer'}`}
                value={r.backgroundCheckStatus}
                onChange={(e) =>
                  void api(`/volunteer-registrations/${r.id}`, {
                    method: 'PATCH',
                    body: { backgroundCheckStatus: e.target.value },
                    version: r.version,
                  })
                    .then(() =>
                      setMsg({ kind: 'success', text: 'Background-check status updated.' }),
                    )
                    .catch((err: unknown) => setMsg({ kind: 'error', text: describeFailure(err) }))
                    .finally(list.reload)
                }
              >
                {['not_required', 'pending', 'cleared', 'not_cleared', 'expired'].map((c) => (
                  <option key={c} value={c}>
                    {label(c)}
                  </option>
                ))}
              </select>
            ),
          },
          { key: 't', header: 'Registered', render: (r) => fmt(r.registeredAt) },
        ]}
      />
    </section>
  );
}
