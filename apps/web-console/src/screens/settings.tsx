/**
 * County settings editors (ADM-01: "event templates, question graphs,
 * planning factors, languages and branding, all audited"). Event templates
 * (CON-02): the name, the SMS keywords, the situation map's first layers and
 * the public safety messages in English and Spanish, saved against the
 * version that was loaded. Planning factors (layer-7 recommendations): each
 * factor with its documented default, changed with a reason through the
 * versioned configuration; a blank field goes back to the default. Branding
 * and languages: the agency name per language, website and header colour
 * residents see, and the languages offered. Every save is audited by the API.
 */
import { useEffect, useState, type FormEvent } from 'react';
import { MAP_LAYERS } from '@cg/intake';
import { api, describeFailure } from '../api/client.ts';
import { DataTable, Field, Status } from '../ui/primitives.tsx';

interface Message {
  key: string;
  texts: { en: { title: string; summary: string }; es?: { title: string; summary: string } };
}
interface Template {
  id: string;
  version: number;
  hazardType: string;
  name: string;
  config: { keywords: string[]; mapLayers: string[]; messages: Message[] } | null;
}

const LAYER_TITLES: Record<(typeof MAP_LAYERS)[number], string> = {
  reports: 'Reports',
  dangerFlags: 'Danger flags',
  verifiedDamage: 'Verified damage',
  needs: 'Needs',
  sites: 'Sites',
  teams: 'Teams',
  hazards: 'Hazards',
  roadClosures: 'Road closures',
  searched: 'Searched',
  outages: 'Outages',
};

type Notice = { kind: 'success' | 'error'; text: string } | null;

export function EventTemplatesScreen() {
  const [templates, setTemplates] = useState<Template[] | null>(null);
  const [pickedId, setPickedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<{
    name: string;
    keywords: string;
    mapLayers: string[];
    messages: Message[];
  } | null>(null);
  const [notice, setNotice] = useState<Notice>(null);
  useEffect(() => {
    api<Template[]>('/event-templates')
      .then(setTemplates)
      .catch((e: unknown) => setNotice({ kind: 'error', text: describeFailure(e) }));
  }, []);
  const picked = templates?.find((t) => t.id === pickedId) ?? null;
  const pick = (t: Template) => {
    setPickedId(t.id);
    setDraft({
      name: t.name,
      keywords: (t.config?.keywords ?? []).join(', '),
      mapLayers: t.config?.mapLayers ?? [],
      messages: t.config?.messages ?? [],
    });
  };
  const keywords = (draft?.keywords ?? '')
    .split(/[\s,]+/)
    .map((k) => k.trim().toUpperCase())
    .filter(Boolean);
  const badKeyword = keywords.find((k) => !/^[A-ZÁÉÍÓÚÑ]{2,20}$/.test(k));
  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (!picked || !draft) return;
    setNotice(null);
    try {
      // The saved template comes back with its new version; nothing is fetched again, so what
      // the person types next is never overwritten by a late answer.
      const saved = await api<Template>(`/event-templates/${picked.id}`, {
        method: 'PUT',
        version: picked.version,
        body: {
          name: draft.name,
          config: {
            keywords,
            mapLayers: draft.mapLayers,
            messages: draft.messages.map((m) => ({
              key: m.key,
              texts: {
                en: m.texts.en,
                ...(m.texts.es?.title && m.texts.es.summary ? { es: m.texts.es } : {}),
              },
            })),
          },
        },
      });
      setTemplates((list) => (list ?? []).map((t) => (t.id === saved.id ? saved : t)));
      pick(saved);
      setNotice({ kind: 'success', text: `${draft.name} saved.` });
    } catch (err) {
      setNotice({ kind: 'error', text: describeFailure(err) });
    }
  };
  const setMessage = (i: number, lang: 'en' | 'es', field: 'title' | 'summary', v: string) =>
    draft &&
    setDraft({
      ...draft,
      messages: draft.messages.map((m, j) =>
        j === i
          ? {
              ...m,
              texts: {
                ...m.texts,
                [lang]: { title: '', summary: '', ...m.texts[lang], [field]: v },
              },
            }
          : m,
      ),
    });
  return (
    <section aria-labelledby="templates-h">
      <h1 id="templates-h">Event templates</h1>
      <p>
        A template presets a new event by hazard: its text keywords, the map&apos;s first layers and
        the safety messages drafted into Resources when the event opens. Changes apply to events
        opened afterwards.
      </p>
      {notice ? <Status kind={notice.kind}>{notice.text}</Status> : null}
      <DataTable
        caption="Templates"
        rows={templates ?? []}
        rowKey={(t) => t.id}
        empty="No templates yet. Add the shipped ones from Events."
        columns={[
          { key: 'name', header: 'Template', render: (t) => t.name },
          { key: 'hazard', header: 'Hazard', render: (t) => t.hazardType.replace(/_/g, ' ') },
          {
            key: 'keywords',
            header: 'Keywords',
            render: (t) => (t.config?.keywords ?? []).join(', ') || '—',
          },
          {
            key: 'act',
            header: 'Action',
            render: (t) => (
              <button type="button" onClick={() => pick(t)}>
                Edit {t.name}
              </button>
            ),
          },
        ]}
      />
      {picked && draft ? (
        <form className="panel" onSubmit={(e) => void save(e)} aria-labelledby="tpl-edit-h">
          <h2 id="tpl-edit-h">Edit {picked.name}</h2>
          <div className="form-grid">
            <Field label="Template name">
              {({ id }) => (
                <input
                  id={id}
                  value={draft.name}
                  onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                  required
                />
              )}
            </Field>
            <Field
              label="Text keywords"
              hint="One word each, separated by commas. A new keyword works only once the county's text number has it registered (docs/06)."
              {...(badKeyword
                ? { error: `"${badKeyword}" is not one word of capital letters.` }
                : {})}
            >
              {({ id, describedBy, invalid }) => (
                <input
                  id={id}
                  aria-describedby={describedBy}
                  aria-invalid={invalid || undefined}
                  value={draft.keywords}
                  onChange={(e) => setDraft({ ...draft, keywords: e.target.value })}
                />
              )}
            </Field>
          </div>
          <fieldset>
            <legend>Map layers shown first</legend>
            {MAP_LAYERS.map((layer) => {
              const id = `layer-${layer}`;
              return (
                <div key={layer}>
                  <input
                    type="checkbox"
                    id={id}
                    checked={draft.mapLayers.includes(layer)}
                    onChange={(e) =>
                      setDraft({
                        ...draft,
                        mapLayers: e.target.checked
                          ? [...draft.mapLayers, layer]
                          : draft.mapLayers.filter((l) => l !== layer),
                      })
                    }
                  />
                  <label htmlFor={id}>{LAYER_TITLES[layer]}</label>
                </div>
              );
            })}
          </fieldset>
          {draft.messages.map((m, i) => (
            <fieldset key={m.key}>
              <legend>Safety message “{m.key}”</legend>
              <div className="form-grid">
                <Field label={`English title (${m.key})`}>
                  {({ id }) => (
                    <input
                      id={id}
                      lang="en"
                      value={m.texts.en.title}
                      onChange={(e) => setMessage(i, 'en', 'title', e.target.value)}
                      required
                    />
                  )}
                </Field>
                <Field label={`English text (${m.key})`}>
                  {({ id }) => (
                    <textarea
                      id={id}
                      lang="en"
                      rows={3}
                      value={m.texts.en.summary}
                      onChange={(e) => setMessage(i, 'en', 'summary', e.target.value)}
                      required
                    />
                  )}
                </Field>
                <Field label={`Spanish title (${m.key})`}>
                  {({ id }) => (
                    <input
                      id={id}
                      lang="es"
                      value={m.texts.es?.title ?? ''}
                      onChange={(e) => setMessage(i, 'es', 'title', e.target.value)}
                    />
                  )}
                </Field>
                <Field label={`Spanish text (${m.key})`}>
                  {({ id }) => (
                    <textarea
                      id={id}
                      lang="es"
                      rows={3}
                      value={m.texts.es?.summary ?? ''}
                      onChange={(e) => setMessage(i, 'es', 'summary', e.target.value)}
                    />
                  )}
                </Field>
              </div>
            </fieldset>
          ))}
          <p className="hint">
            Messages are drafted into Resources unpublished and unreviewed; a person still checks
            and publishes them.
          </p>
          <button type="submit" className="primary" disabled={!!badKeyword || !keywords.length}>
            Save {draft.name}
          </button>
        </form>
      ) : null}
    </section>
  );
}

/** Plain words and units for each planning factor; a factor not listed shows its key. */
const FACTORS: Record<string, string> = {
  shelterSqftPerPerson: 'Shelter floor space per person (sq ft)',
  peoplePerShower: 'People per shower',
  personsPerHousehold: 'People per household',
  coverageKm: 'Shelter coverage distance (km)',
  staleDays: 'Facility details older than this are stale (days)',
  mealsPerPersonPerStop: 'Meals per person at each feeding stop',
  stopsPerCanteen: 'Stops per canteen per day',
  feedingFirstStartHour: 'First feeding stop starts at (hour, 24 h)',
  feedingWindowHours: 'Feeding stop length (hours)',
  feedingGapHours: 'Time between a canteen’s stops (hours)',
  feedingClusterKm: 'Households grouped within (km) for feeding',
  feedingSiteKm: 'Feeding stop site within (km) of its group',
  feedingCoverageKm: 'Feeding coverage distance (km)',
  languageNotePct: 'Language note when a group speaks it (% of households)',
  canteenMinCrew: 'Smallest canteen crew',
  chaplainMinRequests: 'Spiritual care requests before a chaplain is suggested',
  podDailySharePct: 'Share of people served at a distribution point each day (%)',
  podWaterGalPerPersonDay: 'Water per person per day (gallons)',
  podIceLbMinPerPersonDay: 'Ice per person per day, low (lb)',
  podIceLbMaxPerPersonDay: 'Ice per person per day, high (lb)',
  podMealsPerPersonDay: 'Meals per person per day at a distribution point',
  podDays: 'Days a distribution point runs',
  podMinParkingSpaces: 'Fewest parking spaces for a drive-through point',
  walkUpNoVehiclePct: 'Households without a vehicle for a walk-up point (%)',
  walkUpKm: 'Walk-up distance (km)',
  marcHouseholdsPerTable: 'Households per table at a recovery center',
  marcMaxTablesPerService: 'Most tables per service at a recovery center',
  marcSqftPerTable: 'Floor space per table (sq ft)',
  marcBaseSqft: 'Recovery center base floor space (sq ft)',
  marcServices: 'Services at a recovery center',
};

interface Factors {
  defaults: Record<string, number>;
  overrides: Record<string, number>;
  inForce: Record<string, number>;
  version: number | null;
}

export function PlanningFactorsScreen() {
  const [factors, setFactors] = useState<Factors | null>(null);
  const [tenantId, setTenantId] = useState<string | null>(null);
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState<Notice>(null);
  useEffect(() => {
    Promise.all([
      api<Factors>('/recommendations/planning-factors'),
      api<{ tenantId: string }>('/me'),
    ])
      .then(([f, me]) => {
        setFactors(f);
        setTenantId(me.tenantId);
        setEdits(Object.fromEntries(Object.entries(f.overrides).map(([k, v]) => [k, String(v)])));
      })
      .catch((e: unknown) => setNotice({ kind: 'error', text: describeFailure(e) }));
  }, []);
  const keys = factors ? Object.keys(factors.defaults) : [];
  const invalid = Object.entries(edits).filter(
    ([, v]) => v.trim() !== '' && !(Number(v) > 0 && Number.isFinite(Number(v))),
  );
  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (!factors || !tenantId || invalid.length) return;
    setNotice(null);
    const value = Object.fromEntries(
      Object.entries(edits)
        .filter(([k, v]) => v.trim() !== '' && Number(v) !== factors.defaults[k])
        .map(([k, v]) => [k, Number(v)]),
    );
    try {
      // The saved value and its version come back; the fields keep what was typed.
      const saved = await api<{ version: number }>(
        `/tenants/${tenantId}/config/recommendation.planning_factors`,
        {
          method: 'PUT',
          body: { value },
          ...(factors.version !== null ? { version: factors.version } : {}),
        },
      );
      setFactors({
        ...factors,
        overrides: value,
        inForce: { ...factors.defaults, ...value },
        version: saved.version,
      });
      setNotice({ kind: 'success', text: 'Planning factors saved.' });
    } catch (err) {
      setNotice({ kind: 'error', text: describeFailure(err) });
    }
  };
  return (
    <section aria-labelledby="factors-h">
      <h1 id="factors-h">Planning factors</h1>
      <p>
        The numbers the recommendations plan with. Leave a field blank to use the documented
        default. Saving asks for a reason and is recorded.
      </p>
      {notice ? <Status kind={notice.kind}>{notice.text}</Status> : null}
      {factors ? (
        <form onSubmit={(e) => void save(e)} aria-labelledby="factors-h">
          <table>
            <caption>Planning factors, with the default for each</caption>
            <thead>
              <tr>
                <th scope="col">Factor</th>
                <th scope="col">Default</th>
                <th scope="col">This county</th>
              </tr>
            </thead>
            <tbody>
              {keys.map((k) => {
                const id = `factor-${k}`;
                const bad = invalid.some(([x]) => x === k);
                return (
                  <tr key={k}>
                    <th scope="row">
                      <label htmlFor={id}>{FACTORS[k] ?? k}</label>
                    </th>
                    <td>{factors.defaults[k]}</td>
                    <td>
                      <input
                        id={id}
                        inputMode="decimal"
                        placeholder={`Default ${factors.defaults[k]}`}
                        aria-invalid={bad || undefined}
                        aria-describedby={bad ? `${id}-err` : undefined}
                        value={edits[k] ?? ''}
                        onChange={(e) => setEdits({ ...edits, [k]: e.target.value })}
                      />
                      {bad ? (
                        <span id={`${id}-err`} className="error">
                          Enter a number above zero, or leave it blank.
                        </span>
                      ) : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <button type="submit" className="primary" disabled={invalid.length > 0}>
            Save planning factors
          </button>
        </form>
      ) : null}
    </section>
  );
}

interface QuietConfig {
  value: { start?: string; end?: string } | null;
  version: number;
}

/**
 * BRD:FR-09.06: the county's quiet hours for reminder escalation emails, on its own clock. An
 * escalation that comes due inside them waits until they end; help alerts are never held.
 */
export function QuietHoursPanel() {
  const [me, setMe] = useState<{ tenantId: string; actions: string[] } | null>(null);
  const [current, setCurrent] = useState<QuietConfig | null>(null);
  const [form, setForm] = useState({ start: '', end: '' });
  const [notice, setNotice] = useState<Notice>(null);
  useEffect(() => {
    api<{ tenantId: string; actions: string[] }>('/me')
      .then(async (m) => {
        setMe(m);
        if (!m.actions.includes('tenant.config.read')) return;
        const c = await api<QuietConfig>(
          `/tenants/${m.tenantId}/config/reminders.quiet_hours`,
        ).catch(() => null);
        setCurrent(c);
        setForm({ start: c?.value?.start ?? '', end: c?.value?.end ?? '' });
      })
      .catch(() => undefined);
  }, []);
  if (!me || !me.actions.includes('tenant.config.read')) return null;
  const mayChange = me.actions.includes('tenant.config.write');
  const set = current?.value?.start && current.value.end ? current.value : null;
  const save = async (value: { start: string; end: string } | null) => {
    setNotice(null);
    try {
      const saved = await api<QuietConfig>(`/tenants/${me.tenantId}/config/reminders.quiet_hours`, {
        method: 'PUT',
        body: { value },
        ...(current ? { version: current.version } : {}),
      });
      setCurrent(saved);
      setNotice({
        kind: 'success',
        text: value ? `Quiet hours set: ${value.start} to ${value.end}.` : 'Quiet hours removed.',
      });
    } catch (err) {
      setNotice({ kind: 'error', text: describeFailure(err) });
    }
  };
  const valid =
    /^\d{2}:\d{2}$/.test(form.start) && /^\d{2}:\d{2}$/.test(form.end) && form.start !== form.end;
  return (
    <section className="panel" aria-labelledby="quiet-h">
      <h2 id="quiet-h">Quiet hours for escalation emails</h2>
      <p>
        {set
          ? `Escalation emails wait from ${set.start} to ${set.end}, county time, and go out when the quiet hours end.`
          : 'No quiet hours: escalation emails go out as soon as they are due.'}{' '}
        Help alerts and missed safety check-ins are never held.
      </p>
      {notice ? <Status kind={notice.kind}>{notice.text}</Status> : null}
      {mayChange ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (valid) void save({ start: form.start, end: form.end });
          }}
        >
          <div className="form-grid">
            <Field label="Quiet from (county time)">
              {({ id }) => (
                <input
                  id={id}
                  type="time"
                  value={form.start}
                  onChange={(e) => setForm({ ...form, start: e.target.value })}
                />
              )}
            </Field>
            <Field label="Quiet until (county time)">
              {({ id }) => (
                <input
                  id={id}
                  type="time"
                  value={form.end}
                  onChange={(e) => setForm({ ...form, end: e.target.value })}
                />
              )}
            </Field>
          </div>
          <div className="actions" style={{ justifyContent: 'flex-start' }}>
            <button type="submit" className="primary" disabled={!valid}>
              Save quiet hours
            </button>
            {set ? (
              <button type="button" onClick={() => void save(null)}>
                Remove quiet hours
              </button>
            ) : null}
          </div>
        </form>
      ) : null}
    </section>
  );
}

interface TenantBrand {
  id: string;
  kind: string;
  name: string;
  locales: string[];
  version: number;
  branding: { publicName?: { en?: string; es?: string }; website?: string; headerColor?: string };
}

/** Languages with reviewed resident and public pages (EQ-07); the server holds the same list. */
const OFFERED_LANGUAGES = [
  { code: 'en', name: 'English' },
  { code: 'es', name: 'Spanish (Español)' },
];

/** WCAG contrast of white text on a #rrggbb colour, as the server checks it; null when not a colour. */
export function whiteContrast(hex: string): number | null {
  if (!/^#[0-9a-f]{6}$/i.test(hex)) return null;
  const lin = (i: number) => {
    const v = parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16) / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  const l = 0.2126 * lin(0) + 0.7152 * lin(1) + 0.0722 * lin(2);
  return 1.05 / (l + 0.05);
}

/**
 * ADM-01: the county's branding and languages, as residents see them on the
 * report and Find help pages. The agency name per language, the website and
 * the header colour (white text must reach 4.5:1). English and Spanish are
 * always offered to residents. Saving asks for a reason and is recorded.
 */
export function BrandingScreen() {
  const [tenant, setTenant] = useState<TenantBrand | null>(null);
  const [nameEn, setNameEn] = useState('');
  const [nameEs, setNameEs] = useState('');
  const [website, setWebsite] = useState('');
  const [color, setColor] = useState('');
  const [locales, setLocales] = useState<string[]>([]);
  const [notice, setNotice] = useState<Notice>(null);
  const [busy, setBusy] = useState(false);
  const show = (t: TenantBrand) => {
    setTenant(t);
    setNameEn(t.branding.publicName?.en ?? '');
    setNameEs(t.branding.publicName?.es ?? '');
    setWebsite(t.branding.website ?? '');
    setColor(t.branding.headerColor ?? '');
    setLocales(t.locales);
  };
  useEffect(() => {
    api<{ tenantId: string }>('/me')
      .then((me) => api<TenantBrand>(`/tenants/${me.tenantId}`))
      .then(show)
      .catch((e: unknown) => setNotice({ kind: 'error', text: describeFailure(e) }));
  }, []);
  const ratio = color.trim() ? whiteContrast(color.trim()) : null;
  const colorProblem = !color.trim()
    ? null
    : ratio === null
      ? 'Enter a colour like #0b4f6c.'
      : ratio < 4.5
        ? `White text on this colour is too faint: ${ratio.toFixed(1)} to 1, and it needs 4.5 to 1.`
        : null;
  const websiteProblem =
    website.trim() && !/^https:\/\/[^\s/]+\.[^\s]+$/.test(website.trim())
      ? 'Enter the full address, starting with https://'
      : null;
  const required = tenant?.kind === 'partner_org' ? ['en'] : ['en', 'es'];
  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (!tenant || colorProblem || websiteProblem) return;
    setBusy(true);
    setNotice(null);
    const publicName = {
      ...(nameEn.trim() ? { en: nameEn.trim() } : {}),
      ...(nameEs.trim() ? { es: nameEs.trim() } : {}),
    };
    const branding = {
      ...(Object.keys(publicName).length ? { publicName } : {}),
      ...(website.trim() ? { website: website.trim() } : {}),
      ...(color.trim() ? { headerColor: color.trim().toLowerCase() } : {}),
    };
    try {
      const saved = await api<TenantBrand>(`/tenants/${tenant.id}`, {
        method: 'PATCH',
        body: { branding, locales },
        version: tenant.version,
      });
      show(saved);
      setNotice({ kind: 'success', text: 'Branding and languages saved.' });
    } catch (err) {
      setNotice({ kind: 'error', text: describeFailure(err) });
    } finally {
      setBusy(false);
    }
  };
  const fallbackName = tenant ? `${tenant.name} Emergency Management` : '';
  return (
    <section aria-labelledby="brand-h">
      <h1 id="brand-h">Branding and languages</h1>
      <p>
        How residents see the county on the report and Find help pages. Leave a field blank to use
        the standard wording. Saving asks for a reason and is recorded.
      </p>
      {notice ? <Status kind={notice.kind}>{notice.text}</Status> : null}
      {tenant ? (
        <form onSubmit={(e) => void save(e)} aria-labelledby="brand-h">
          <Field
            label="Agency name in English"
            hint={`At the top of every resident page. Blank shows “${fallbackName}”.`}
          >
            {({ id, describedBy }) => (
              <input
                id={id}
                aria-describedby={describedBy}
                value={nameEn}
                maxLength={120}
                onChange={(e) => setNameEn(e.target.value)}
              />
            )}
          </Field>
          <Field
            label="Agency name in Spanish"
            hint="Shown to residents reading in Spanish. Blank uses the standard Spanish wording."
          >
            {({ id, describedBy }) => (
              <input
                id={id}
                lang="es"
                aria-describedby={describedBy}
                value={nameEs}
                maxLength={120}
                onChange={(e) => setNameEs(e.target.value)}
              />
            )}
          </Field>
          <Field
            label="County website"
            hint="Linked at the foot of the resident and Find help pages."
            {...(websiteProblem ? { error: websiteProblem } : {})}
          >
            {({ id, describedBy }) => (
              <input
                id={id}
                type="url"
                inputMode="url"
                aria-describedby={describedBy}
                aria-invalid={websiteProblem ? true : undefined}
                value={website}
                placeholder="https://"
                onChange={(e) => setWebsite(e.target.value)}
              />
            )}
          </Field>
          <Field
            label="Header colour"
            hint="A colour like #0b4f6c. The header's text is white, so the colour must be dark enough to read it."
            {...(colorProblem ? { error: colorProblem } : {})}
          >
            {({ id, describedBy }) => (
              <input
                id={id}
                aria-describedby={describedBy}
                aria-invalid={colorProblem ? true : undefined}
                value={color}
                maxLength={7}
                onChange={(e) => setColor(e.target.value)}
              />
            )}
          </Field>
          {ratio !== null && !colorProblem ? (
            <p
              className="brand-sample"
              ref={(node) => {
                // The sample takes the colour through the style object, which the CSP allows.
                if (node) {
                  node.style.background = color.trim();
                  node.style.color = '#ffffff';
                }
              }}
            >
              {nameEn.trim() || fallbackName}: white text at {ratio.toFixed(1)} to 1.
            </p>
          ) : null}
          <fieldset>
            <legend>Languages offered to residents</legend>
            {OFFERED_LANGUAGES.map((l) => {
              const locked = required.includes(l.code);
              const id = `lang-${l.code}`;
              return (
                <div key={l.code}>
                  <input
                    type="checkbox"
                    id={id}
                    checked={locales.includes(l.code)}
                    disabled={locked}
                    onChange={(e) =>
                      setLocales((cur) =>
                        e.target.checked ? [...cur, l.code] : cur.filter((x) => x !== l.code),
                      )
                    }
                  />{' '}
                  <label htmlFor={id}>
                    {l.name}
                    {locked ? ' (always offered)' : ''}
                  </label>
                </div>
              );
            })}
            <p className="hint">
              {tenant.kind === 'partner_org'
                ? 'English is always offered.'
                : 'English and Spanish are always offered to residents.'}{' '}
              Another language is added once its resident and public pages are translated and
              reviewed.
            </p>
          </fieldset>
          <button
            type="submit"
            className="primary"
            disabled={busy || Boolean(colorProblem) || Boolean(websiteProblem)}
          >
            {busy ? 'Saving…' : 'Save branding and languages'}
          </button>
        </form>
      ) : null}
    </section>
  );
}
