/**
 * Health notices (FL:FR-06): public health drafts a boil-water,
 * do-not-use-water or safety notice for an area, by ZIP codes or a circle,
 * in English and, when given, Spanish. Before approval anyone can check its
 * reach, as counts only. A second person approves it with a reason (ADM-05
 * G4: never the drafter): it is published on the public help page and
 * residents in the area who agreed to be contacted are told once. Ending it,
 * as lifted or withdrawn, takes it off the page and can tell them it ended.
 */
import { useEffect, useState, type FormEvent } from 'react';
import { api, describeFailure } from '../api/client.ts';
import { DataTable, Field, Status, fmt } from '../ui/primitives.tsx';

interface Notice {
  id: string;
  version: number;
  kind: 'boil_water' | 'do_not_use_water' | 'safety';
  en: { title: string; body: string };
  es: { title: string; body: string } | null;
  areaLabel: string;
  zips: string[];
  circle: { lat: number; lon: number; radiusM: number } | null;
  status: 'draft' | 'active' | 'ended';
  expiresAt: string | null;
  createdAt: string;
  approvedAt: string | null;
  endedAt: string | null;
  endReason: 'lifted' | 'withdrawn' | null;
  sent: { sms: number; email: number; at: string | null };
  endedSent: { sms: number; email: number; at: string | null };
}
interface Reach {
  sms: number;
  email: number;
  unreachable: number;
}

const KIND = {
  boil_water: 'Boil water before use',
  do_not_use_water: 'Do not use the tap water',
  safety: 'Safety notice',
} as const;
const STATUS = {
  draft: 'Draft, waiting for a second person to approve',
  active: 'In force: on the public page',
  ended: 'Ended',
} as const;

const EMPTY = {
  kind: 'boil_water' as Notice['kind'],
  titleEn: '',
  bodyEn: '',
  titleEs: '',
  bodyEs: '',
  areaLabel: '',
  zips: '',
  lat: '',
  lon: '',
  radiusM: '',
  expiresAt: '',
};

export function HealthNoticesScreen() {
  const [list, setList] = useState<Notice[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);
  const [f, setF] = useState(EMPTY);
  const [reach, setReach] = useState<Record<string, Reach>>({});
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let live = true;
    api<Notice[]>('/health-notices')
      .then((d) => live && (setList(d), setError(null)))
      .catch((e: unknown) => live && setError(describeFailure(e)));
    return () => {
      live = false;
    };
  }, [tick]);
  const reload = () => setTick((n) => n + 1);

  const draft = async (e: FormEvent) => {
    e.preventDefault();
    const zips = f.zips
      .split(/[\s,]+/)
      .map((z) => z.trim())
      .filter(Boolean);
    const circle =
      f.lat && f.lon && f.radiusM
        ? { lat: Number(f.lat), lon: Number(f.lon), radiusM: Number(f.radiusM) }
        : undefined;
    try {
      await api('/health-notices', {
        body: {
          kind: f.kind,
          en: { title: f.titleEn.trim(), body: f.bodyEn.trim() },
          ...(f.titleEs.trim() && f.bodyEs.trim()
            ? { es: { title: f.titleEs.trim(), body: f.bodyEs.trim() } }
            : {}),
          areaLabel: f.areaLabel.trim(),
          zips,
          ...(circle ? { circle } : {}),
          ...(f.expiresAt ? { expiresAt: new Date(f.expiresAt).toISOString() } : {}),
        },
      });
      setMsg({
        kind: 'success',
        text: 'Draft saved. Someone else approves it before it is published or sent.',
      });
      setF(EMPTY);
      reload();
    } catch (err) {
      setMsg({ kind: 'error', text: describeFailure(err) });
    }
  };
  const checkReach = async (n: Notice) => {
    try {
      const r = await api<Reach>(`/health-notices/${n.id}/reach`);
      setReach((m) => ({ ...m, [n.id]: r }));
    } catch (err) {
      setMsg({ kind: 'error', text: describeFailure(err) });
    }
  };
  const approve = async (n: Notice) => {
    try {
      await api(`/health-notices/${n.id}/approve`, { method: 'POST', version: n.version });
      setMsg({
        kind: 'success',
        text: `"${n.en.title}" is published and residents in the area are being told.`,
      });
    } catch (err) {
      setMsg({ kind: 'error', text: describeFailure(err) });
    }
    reload();
  };
  const end = async (n: Notice, reason: 'lifted' | 'withdrawn') => {
    try {
      await api(`/health-notices/${n.id}/end`, {
        body: { reason, tellResidents: true },
        version: n.version,
      });
      setMsg({
        kind: 'success',
        text: `"${n.en.title}" has ended (${reason}). Residents who were told are told it ended.`,
      });
    } catch (err) {
      setMsg({ kind: 'error', text: describeFailure(err) });
    }
    reload();
  };
  const set = (k: keyof typeof EMPTY) => (e: { target: { value: string } }) =>
    setF({ ...f, [k]: e.target.value });

  return (
    <section aria-labelledby="hn-h">
      <h1 id="hn-h">Health notices</h1>
      <p>
        Boil-water, do-not-use-water and safety notices for an area. A notice is published on the
        public help page and sent to residents in the area who agreed to be contacted (a text only
        with their text opt-in, an email only when email is how they asked to be reached) once a
        second person approves it. Messages never read like an emergency alert.
      </p>
      {msg ? <Status kind={msg.kind}>{msg.text}</Status> : null}
      {error ? <Status kind="error">{error}</Status> : null}
      <form className="panel" onSubmit={(e) => void draft(e)} aria-labelledby="hn-new-h">
        <h2 id="hn-new-h">Draft a notice</h2>
        <div className="form-grid">
          <Field label="Kind">
            {({ id }) => (
              <select id={id} value={f.kind} onChange={set('kind')}>
                {Object.entries(KIND).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <Field label="Area, as the public reads it" hint="For example: Cedar Ridge water system">
            {({ id, describedBy }) => (
              <input
                id={id}
                aria-describedby={describedBy}
                value={f.areaLabel}
                onChange={set('areaLabel')}
                maxLength={80}
                required
              />
            )}
          </Field>
          <Field label="ZIP codes" hint="Separated by spaces or commas. Or give a circle below.">
            {({ id, describedBy }) => (
              <input
                id={id}
                aria-describedby={describedBy}
                inputMode="numeric"
                value={f.zips}
                onChange={set('zips')}
              />
            )}
          </Field>
          <Field label="Circle centre latitude (optional)">
            {({ id }) => <input id={id} inputMode="decimal" value={f.lat} onChange={set('lat')} />}
          </Field>
          <Field label="Circle centre longitude (optional)">
            {({ id }) => <input id={id} inputMode="decimal" value={f.lon} onChange={set('lon')} />}
          </Field>
          <Field label="Circle radius in metres (optional)">
            {({ id }) => (
              <input id={id} inputMode="numeric" value={f.radiusM} onChange={set('radiusM')} />
            )}
          </Field>
          <Field label="Ends on its own at (optional)">
            {({ id }) => (
              <input
                id={id}
                type="datetime-local"
                value={f.expiresAt}
                onChange={set('expiresAt')}
              />
            )}
          </Field>
        </div>
        <fieldset>
          <legend>English</legend>
          <Field label="Title in English">
            {({ id }) => (
              <input id={id} value={f.titleEn} onChange={set('titleEn')} maxLength={100} required />
            )}
          </Field>
          <Field label="Notice in English" hint="What to do, until when, and where to learn more.">
            {({ id, describedBy }) => (
              <textarea
                id={id}
                aria-describedby={describedBy}
                rows={4}
                value={f.bodyEn}
                onChange={set('bodyEn')}
                maxLength={2000}
                required
              />
            )}
          </Field>
        </fieldset>
        <fieldset lang="es">
          <legend lang="en">Spanish (recommended)</legend>
          <Field label="Título en español">
            {({ id }) => (
              <input id={id} value={f.titleEs} onChange={set('titleEs')} maxLength={100} />
            )}
          </Field>
          <Field label="Aviso en español">
            {({ id }) => (
              <textarea
                id={id}
                rows={4}
                value={f.bodyEs}
                onChange={set('bodyEs')}
                maxLength={2000}
              />
            )}
          </Field>
        </fieldset>
        <button
          type="submit"
          className="primary"
          disabled={!f.titleEn.trim() || !f.bodyEn.trim() || !f.areaLabel.trim()}
        >
          Save the draft
        </button>
      </form>
      <DataTable
        caption="Health notices, newest first"
        rows={list ?? []}
        rowKey={(n) => n.id}
        empty="No health notices yet."
        columns={[
          { key: 't', header: 'Title', render: (n) => n.en.title },
          { key: 'k', header: 'Kind', render: (n) => KIND[n.kind] },
          {
            key: 'a',
            header: 'Area',
            render: (n) =>
              [
                n.areaLabel,
                n.zips.length ? `ZIP ${n.zips.join(', ')}` : null,
                n.circle ? `within ${n.circle.radiusM} m of a point` : null,
              ]
                .filter(Boolean)
                .join('; '),
          },
          {
            key: 's',
            header: 'Status',
            render: (n) =>
              n.status === 'ended'
                ? `Ended (${n.endReason ?? ''}) ${fmt(n.endedAt)}`
                : STATUS[n.status] + (n.status === 'active' ? ` since ${fmt(n.approvedAt)}` : ''),
          },
          {
            key: 'r',
            header: 'Reach',
            render: (n) => {
              if (n.status !== 'draft')
                return `${n.sent.sms} texts and ${n.sent.email} emails queued${
                  n.endedSent.at ? `; told it ended: ${n.endedSent.sms + n.endedSent.email}` : ''
                }`;
              const r = reach[n.id];
              return r ? (
                `${r.sms} by text, ${r.email} by email, ${r.unreachable} cannot be reached`
              ) : (
                <button type="button" onClick={() => void checkReach(n)}>
                  Check reach of {n.en.title}
                </button>
              );
            },
          },
          {
            key: 'x',
            header: 'Action',
            render: (n) =>
              n.status === 'draft' ? (
                <button type="button" className="primary" onClick={() => void approve(n)}>
                  Approve and publish {n.en.title}
                </button>
              ) : n.status === 'active' ? (
                <>
                  <button type="button" onClick={() => void end(n, 'lifted')}>
                    Lift {n.en.title}
                  </button>{' '}
                  <button type="button" onClick={() => void end(n, 'withdrawn')}>
                    Withdraw {n.en.title}
                  </button>
                </>
              ) : (
                '—'
              ),
          },
        ]}
      />
    </section>
  );
}
