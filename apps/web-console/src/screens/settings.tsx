/**
 * County settings editors (ADM-01: "event templates, question graphs,
 * planning factors, languages and branding, all audited"). Event templates
 * (CON-02): the name, the SMS keywords, the situation map's first layers and
 * the public safety messages in English and Spanish, saved against the
 * version that was loaded. Planning factors (layer-7 recommendations): each
 * factor with its documented default, changed with a reason through the
 * versioned configuration; a blank field goes back to the default. Every
 * save is audited by the API.
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
