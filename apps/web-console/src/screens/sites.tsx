/**
 * Sites and the publication log (plan console screens 7 and 9; CON-09,
 * PUB-02–06, PUB-11, PUB-15): open, update, confirm, publish with the
 * approval dialog, close and unpublish a site; the confidential flag; the
 * next-nearest preview from the public view; alert drafts from a site
 * change; the log of what went public, by whom and when. Sites a partner
 * posted itself (2026-10-15) show the posting organization. Layer-7 task G
 * (PUB-11, PUB-12, PUB-14, AI-04): the social post, radio loop and net
 * read-out sit with the alert texts, and the AI assistant can redraft any of
 * them from the same facts, labelled and checked; the person copies what
 * they keep, and its record says whether they changed it (AIG-01). A simple
 * graphic per language says the same facts, with its alt text (PUB-12). The AI
 * voice speaks an approved radio script into an audio file that opens by
 * saying the voice is computer-generated, with its transcript (PUB-14).
 */
import { Fragment, useId, useRef, useState, type FormEvent } from 'react';
import { api, describeFailure, download, fetchBlob } from '../api/client.ts';
import { DataTable, Field, Status, Toolbar, fmt } from '../ui/primitives.tsx';
import { useList } from './admin.tsx';

interface Site {
  id: string;
  version: number;
  kind: string;
  name: string;
  slug: string;
  status: string;
  address: { line1: string | null; city: string | null; postal: string | null } | null;
  position: { lat: number; lon: number } | null;
  capacity: number | null;
  occupancy: number | null;
  pets: string;
  confidential: boolean;
  confirmEveryHours: number;
  lastConfirmedAt: string | null;
  stale: boolean;
  confirmDueAt: string | null;
  published: boolean;
  publishedAt: string | null;
  postedBy: { tenantId: string; name: string | null } | null;
}
interface Publication {
  id: string;
  subjectKind: string;
  subjectId: string;
  subjectVersion: number;
  approvedBy: string;
  approvedAt: string;
  channels: string[];
  reason: string;
  unpublishedAt: string | null;
  snapshot: {
    name?: string;
    slug?: string;
    change?: string;
    postedBy?: { organization?: string; approver?: string | null };
  } | null;
}
interface AlertDraft {
  lang: string;
  wea90: string;
  wea360: string;
  massNotification: string;
  social: string;
  radioLoop: string;
  netReadout: string;
  card: AlertCard;
}
interface AlertCard {
  heading: string;
  status: string;
  name: string;
  details: string[];
  footer: string;
  alt: string;
}
type DraftForm = Exclude<keyof AlertDraft, 'lang' | 'card'>;
const FORMS: { key: DraftForm; en: string; es: string; max: number }[] = [
  { key: 'wea90', en: 'English, 90', es: 'Español, 90', max: 90 },
  { key: 'wea360', en: 'English, 360', es: 'Español, 360', max: 360 },
  { key: 'massNotification', en: 'Mass notification', es: 'Notificación masiva', max: 1000 },
  { key: 'social', en: 'Social media post', es: 'Publicación en redes sociales', max: 280 },
  { key: 'radioLoop', en: 'Radio loop (TIS)', es: 'Mensaje de radio (TIS)', max: 1500 },
  {
    key: 'netReadout',
    en: 'Amateur radio net read-out',
    es: 'Lectura para la red de radioaficionados',
    max: 1500,
  },
];
interface AiPublic {
  form: DraftForm;
  language: string;
  text: string;
  sentences: { text: string; factIds: string[] }[];
  facts: { id: string; label: string; value: string | number | null }[];
  provider: string;
  model: string;
  outputId: string;
}

const KINDS = [
  'shelter',
  'feeding',
  'pod',
  'marc',
  'cooling',
  'warming',
  'reporting',
  'charging',
  'other',
];
const STATUSES = ['planned', 'open', 'limited', 'full', 'closed'];
const label = (s: string) => s.replace(/_/g, ' ');

const blank = {
  kind: 'shelter',
  name: '',
  line1: '',
  city: '',
  postal: '',
  lat: '',
  lon: '',
  status: 'open',
  capacity: '',
  pets: 'unknown',
  hours: '',
  confidential: false,
  confirmEveryHours: '12',
};

export function SitesScreen() {
  const { rows, error, reload } = useList<Site>('/sites?limit=200');
  const [form, setForm] = useState(blank);
  const [msg, setMsg] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<{
    siteId: string;
    site: string;
    change: string;
    drafts: AlertDraft[];
  } | null>(null);
  const [note, setNote] = useState('');

  const create = async (e: FormEvent) => {
    e.preventDefault();
    setMsg(null);
    try {
      await api('/sites', {
        body: {
          kind: form.kind,
          name: form.name,
          status: form.status,
          address: {
            line1: form.line1 || null,
            city: form.city || null,
            postal: form.postal || null,
          },
          position: form.lat && form.lon ? { lat: Number(form.lat), lon: Number(form.lon) } : null,
          capacity: form.capacity ? Number(form.capacity) : null,
          pets: form.pets,
          hours: form.hours ? { daily: form.hours } : {},
          confidential: form.confidential,
          confirmEveryHours: Number(form.confirmEveryHours) || 12,
        },
      });
      setMsg(`${form.name} added. Confirm it and publish it when it is ready.`);
      setForm(blank);
      reload();
    } catch (err) {
      setMsg(describeFailure(err));
    }
  };
  const act = async (site: Site, verb: string, body: Record<string, unknown> = {}) => {
    setMsg(null);
    try {
      await api(`/sites/${site.id}/${verb}`, { body });
      const past: Record<string, string> = {
        publish: 'published on every channel',
        unpublish: 'taken off every channel',
        confirm: 'confirmed',
        close: 'closed',
      };
      setMsg(`${site.name}: ${past[verb] ?? verb}.`);
      reload();
    } catch (err) {
      setMsg(describeFailure(err));
    }
  };
  const draft = async (site: Site, change: string) => {
    setMsg(null);
    try {
      const r = await api<{ drafts: AlertDraft[] }>('/alerts/draft', {
        body: { siteId: site.id, change },
      });
      setDrafts({ siteId: site.id, site: site.name, change, drafts: r.drafts });
    } catch (err) {
      setMsg(describeFailure(err));
    }
  };

  return (
    <section aria-labelledby="sites-h">
      <h1 id="sites-h">Sites</h1>
      <p>
        Nothing goes public without a named approver and a reason; a site past its reconfirmation
        window disappears from every channel until confirmed.
      </p>
      {error ? <Status kind="error">{error}</Status> : null}
      {msg ? <Status kind="info">{msg}</Status> : null}
      <Field
        label="Note for the next action"
        hint="Why you confirm, close, publish or unpublish; it goes into the audit log and the publication log."
      >
        {({ id, describedBy }) => (
          <input
            id={id}
            aria-describedby={describedBy}
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
        )}
      </Field>
      <DataTable
        caption="Sites"
        rows={rows ?? []}
        rowKey={(s) => s.id}
        empty="No sites yet."
        columns={[
          {
            key: 'name',
            header: 'Site',
            render: (s) => (s.confidential ? `${s.name} (confidential)` : s.name),
          },
          {
            key: 'posted',
            header: 'Posted by',
            render: (s) => (s.postedBy ? (s.postedBy.name ?? 'a partner organization') : 'county'),
          },
          { key: 'kind', header: 'Kind', render: (s) => label(s.kind) },
          {
            key: 'status',
            header: 'Status',
            render: (s) => <span className={`badge badge-${s.status}`}>{label(s.status)}</span>,
          },
          {
            key: 'where',
            header: 'Address',
            render: (s) =>
              [s.address?.line1, s.address?.city, s.address?.postal].filter(Boolean).join(', ') ||
              '—',
          },
          {
            key: 'cap',
            header: 'Occupancy',
            render: (s) => (s.capacity !== null ? `${s.occupancy ?? '—'} / ${s.capacity}` : '—'),
          },
          {
            key: 'pub',
            header: 'Public',
            render: (s) =>
              s.published ? (
                s.stale ? (
                  <span className="badge badge-full">
                    hidden: confirm due {fmt(s.confirmDueAt)}
                  </span>
                ) : (
                  `published ${fmt(s.publishedAt)}`
                )
              ) : (
                'not published'
              ),
          },
          { key: 'confirmed', header: 'Last confirmed', render: (s) => fmt(s.lastConfirmedAt) },
          {
            key: 'act',
            header: 'Actions',
            render: (s) => (
              <span className="actions">
                <button
                  type="button"
                  onClick={() => act(s, 'confirm', { note: note || undefined })}
                >
                  Confirm
                </button>
                {s.status !== 'full' ? (
                  <button
                    type="button"
                    onClick={() => act(s, 'confirm', { status: 'full', note: note || undefined })}
                  >
                    Full
                  </button>
                ) : null}
                {s.status !== 'open' ? (
                  <button
                    type="button"
                    onClick={() => act(s, 'confirm', { status: 'open', note: note || undefined })}
                  >
                    Open
                  </button>
                ) : null}
                {s.status !== 'closed' ? (
                  <button
                    type="button"
                    disabled={note.trim().length < 3}
                    onClick={() => act(s, 'close', { note })}
                  >
                    Close
                  </button>
                ) : null}
                {s.confidential ? null : s.published ? (
                  <button type="button" onClick={() => act(s, 'unpublish')}>
                    Unpublish
                  </button>
                ) : (
                  <button type="button" className="primary" onClick={() => act(s, 'publish')}>
                    Publish…
                  </button>
                )}
                {s.confidential ? null : (
                  <button
                    type="button"
                    className="link"
                    onClick={() =>
                      draft(
                        s,
                        s.status === 'closed' ? 'closed' : s.status === 'full' ? 'full' : 'opened',
                      )
                    }
                  >
                    Alert draft
                  </button>
                )}
              </span>
            ),
          },
        ]}
      />
      {drafts ? (
        <div className="panel" role="region" aria-label={`Alert drafts for ${drafts.site}`}>
          <h2>Alert drafts: {drafts.site}</h2>
          <p>
            Sized for Wireless Emergency Alerts, the county's mass-notification tool, social media
            and spoken radio. The county sends them through its own authorized tools; nothing is
            sent from here.
          </p>
          {drafts.drafts.map((d) => (
            <dl className="meta" key={d.lang} lang={d.lang}>
              {FORMS.map((f) => (
                <Fragment key={f.key}>
                  <dt>{d.lang === 'es' ? f.es : f.en}</dt>
                  <dd>{d[f.key]}</dd>
                </Fragment>
              ))}
            </dl>
          ))}
          <section aria-labelledby="social-cards-h">
            <h3 id="social-cards-h">Graphics for the social post</h3>
            <p>
              The same facts as a picture. Post it with its alt text so everyone gets the message.
            </p>
            {drafts.drafts.map((d) => (
              <SocialCard key={d.lang} card={d.card} lang={d.lang as 'en' | 'es'} />
            ))}
          </section>
          <AiPublicDraft key={`${drafts.siteId}:${drafts.change}`} {...drafts} />
          <RadioAudio key={`audio:${drafts.siteId}:${drafts.change}`} {...drafts} />
        </div>
      ) : null}
      <h2>Add a site</h2>
      <form onSubmit={create} className="form-grid">
        <Field label="Kind">
          {({ id }) => (
            <select
              id={id}
              value={form.kind}
              onChange={(e) => setForm({ ...form, kind: e.target.value })}
            >
              {KINDS.map((k) => (
                <option key={k} value={k}>
                  {label(k)}
                </option>
              ))}
            </select>
          )}
        </Field>
        <Field label="Name">
          {({ id }) => (
            <input
              id={id}
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              required
            />
          )}
        </Field>
        <Field label="Street address">
          {({ id }) => (
            <input
              id={id}
              value={form.line1}
              onChange={(e) => setForm({ ...form, line1: e.target.value })}
            />
          )}
        </Field>
        <Field label="City">
          {({ id }) => (
            <input
              id={id}
              value={form.city}
              onChange={(e) => setForm({ ...form, city: e.target.value })}
            />
          )}
        </Field>
        <Field label="ZIP">
          {({ id }) => (
            <input
              id={id}
              value={form.postal}
              onChange={(e) => setForm({ ...form, postal: e.target.value })}
              inputMode="numeric"
            />
          )}
        </Field>
        <Field
          label="Latitude"
          hint="Optional until the geocoder runs; needed for nearest-first and the map."
        >
          {({ id, describedBy }) => (
            <input
              id={id}
              aria-describedby={describedBy}
              value={form.lat}
              onChange={(e) => setForm({ ...form, lat: e.target.value })}
              inputMode="decimal"
            />
          )}
        </Field>
        <Field label="Longitude">
          {({ id }) => (
            <input
              id={id}
              value={form.lon}
              onChange={(e) => setForm({ ...form, lon: e.target.value })}
              inputMode="decimal"
            />
          )}
        </Field>
        <Field label="Status">
          {({ id }) => (
            <select
              id={id}
              value={form.status}
              onChange={(e) => setForm({ ...form, status: e.target.value })}
            >
              {STATUSES.map((s) => (
                <option key={s} value={s}>
                  {label(s)}
                </option>
              ))}
            </select>
          )}
        </Field>
        <Field label="Capacity">
          {({ id }) => (
            <input
              id={id}
              value={form.capacity}
              onChange={(e) => setForm({ ...form, capacity: e.target.value })}
              inputMode="numeric"
            />
          )}
        </Field>
        <Field label="Hours" hint="For example 08:00–20:00, or leave empty for 24 hours.">
          {({ id, describedBy }) => (
            <input
              id={id}
              aria-describedby={describedBy}
              value={form.hours}
              onChange={(e) => setForm({ ...form, hours: e.target.value })}
            />
          )}
        </Field>
        <Field label="Pets">
          {({ id }) => (
            <select
              id={id}
              value={form.pets}
              onChange={(e) => setForm({ ...form, pets: e.target.value })}
            >
              <option value="unknown">Ask</option>
              <option value="yes">Pets welcome</option>
              <option value="service_animals">Service animals only</option>
              <option value="no">No pets</option>
            </select>
          )}
        </Field>
        <Field
          label="Reconfirm every (hours)"
          hint="Past this, the site is hidden on every public channel until confirmed (PUB-03)."
        >
          {({ id, describedBy }) => (
            <input
              id={id}
              aria-describedby={describedBy}
              value={form.confirmEveryHours}
              onChange={(e) => setForm({ ...form, confirmEveryHours: e.target.value })}
              inputMode="numeric"
            />
          )}
        </Field>
        <Field label="Confidential" hint="Never published; staff refer people privately (PUB-05).">
          {({ id, describedBy }) => (
            <input
              id={id}
              type="checkbox"
              aria-describedby={describedBy}
              checked={form.confidential}
              onChange={(e) => setForm({ ...form, confidential: e.target.checked })}
            />
          )}
        </Field>
        <div className="actions">
          <button type="submit" className="primary">
            Add site
          </button>
        </div>
      </form>
    </section>
  );
}

export function PublicationsScreen() {
  const { rows, error } = useList<Publication>('/publications?limit=200');
  return (
    <section aria-labelledby="pub-h">
      <h1 id="pub-h">Publication log</h1>
      <p>
        What went public, where, when, approved by whom and why; and when it came down (PUB-06).
      </p>
      {error ? <Status kind="error">{error}</Status> : null}
      <Toolbar>
        <a href="/api/public/help/county/media?lang=en" target="_blank" rel="noopener">
          Media sheet (opens the public page)
        </a>
      </Toolbar>
      <DataTable
        caption="Publications"
        rows={rows ?? []}
        rowKey={(p) => p.id}
        columns={[
          { key: 'kind', header: 'Kind', render: (p) => label(p.subjectKind) },
          {
            key: 'what',
            header: 'What',
            render: (p) =>
              p.snapshot?.name ??
              p.snapshot?.slug ??
              (p.snapshot?.change ? `alert: ${p.snapshot.change}` : p.subjectId),
          },
          { key: 'v', header: 'Version', render: (p) => String(p.subjectVersion) },
          { key: 'when', header: 'Approved', render: (p) => fmt(p.approvedAt) },
          {
            key: 'who',
            header: 'By',
            // A partner's own post (2026-10-15) names the organization and its approver.
            render: (p) =>
              p.snapshot?.postedBy?.organization ? (
                `Posted by ${p.snapshot.postedBy.organization}${p.snapshot.postedBy.approver ? ` (${p.snapshot.postedBy.approver})` : ''}`
              ) : (
                <code>{p.approvedBy.slice(0, 8)}</code>
              ),
          },
          { key: 'why', header: 'Reason', render: (p) => p.reason },
          { key: 'channels', header: 'Channels', render: (p) => p.channels.join(', ') },
          { key: 'down', header: 'Taken down', render: (p) => fmt(p.unpublishedAt) },
        ]}
      />
    </section>
  );
}

/**
 * The AI assistant's redraft of one public text (PUB-11, PUB-12, PUB-14,
 * AI-04): labelled with its provider and model, checked against the site's
 * facts, editable, and recorded as kept or changed when copied (AIG-01).
 * With the assistant off, the server says so and the rules' texts stay.
 */
function AiPublicDraft({ siteId, site, change }: { siteId: string; site: string; change: string }) {
  const [form, setForm] = useState<DraftForm>('social');
  const [language, setLanguage] = useState('en');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [ai, setAi] = useState<AiPublic | null>(null);
  const [text, setText] = useState('');
  const [copied, setCopied] = useState(false);
  const formOf = (k: DraftForm) => FORMS.find((f) => f.key === k)!;

  const ask = async () => {
    setBusy(true);
    setMsg(null);
    setCopied(false);
    try {
      const r = await api<AiPublic>('/alerts/ai-draft', {
        body: { siteId, change, form, language },
      });
      setAi(r);
      setText(r.text);
    } catch (err) {
      setAi(null);
      setMsg(describeFailure(err));
    } finally {
      setBusy(false);
    }
  };
  const copy = async () => {
    if (!ai) return;
    setMsg(null);
    try {
      await navigator.clipboard?.writeText(text).catch(() => undefined);
      if (!copied)
        await api(`/alerts/ai-draft/${ai.outputId}/kept`, { body: { changed: text !== ai.text } });
      setCopied(true);
    } catch (err) {
      setMsg(describeFailure(err));
    }
  };
  const max = ai ? formOf(ai.form).max : 0;
  const factLabel = new Map(ai?.facts.map((f) => [f.id, f.label]) ?? []);

  return (
    <section aria-labelledby="ai-public-h">
      <h3 id="ai-public-h">Draft with the AI assistant</h3>
      <p>
        The assistant rewrites one text from the same facts about {site}. Every sentence names the
        facts it uses and every figure is checked against them; a draft that strays is not shown.
      </p>
      <div className="form-grid">
        <Field label="Text">
          {({ id }) => (
            <select id={id} value={form} onChange={(e) => setForm(e.target.value as DraftForm)}>
              {FORMS.map((f) => (
                <option key={f.key} value={f.key}>
                  {f.en} (at most {f.max} characters)
                </option>
              ))}
            </select>
          )}
        </Field>
        <Field label="Language">
          {({ id }) => (
            <select id={id} value={language} onChange={(e) => setLanguage(e.target.value)}>
              <option value="en">English</option>
              <option value="es">Spanish</option>
            </select>
          )}
        </Field>
      </div>
      <Toolbar>
        <button type="button" onClick={ask} disabled={busy} aria-busy={busy}>
          {busy ? 'Drafting…' : 'Draft with the AI assistant'}
        </button>
      </Toolbar>
      {msg ? <Status kind="error">{msg}</Status> : null}
      {ai ? (
        <div>
          <Status kind="info">
            {`${formOf(ai.form).en} drafted by the AI assistant (${ai.provider}, ${ai.model}); every figure was checked against the site's facts. Read it and change what needs changing before you use it.`}
          </Status>
          <Field
            label={`AI draft: ${formOf(ai.form).en}, ${ai.language === 'es' ? 'Spanish' : 'English'}`}
          >
            {({ id }) => (
              <textarea
                id={id}
                lang={ai.language}
                rows={ai.form === 'wea90' ? 2 : 6}
                value={text}
                aria-describedby="ai-public-count"
                onChange={(e) => {
                  setText(e.target.value);
                  setCopied(false);
                }}
              />
            )}
          </Field>
          <p id="ai-public-count" aria-live="polite">
            {text.length} of {max} characters
            {text.length > max ? ': too long for this channel' : ''}
          </p>
          <Toolbar>
            <button type="button" className="primary" onClick={copy} disabled={text.length > max}>
              Copy for sending
            </button>
          </Toolbar>
          {copied ? (
            <Status kind="success">
              Copied. Send it through the county's authorized tool; nothing is sent from here.
            </Status>
          ) : null}
          <details>
            <summary>The facts each sentence uses</summary>
            <ol>
              {ai.sentences.map((x, i) => (
                <li key={i} lang={ai.language}>
                  {x.text}{' '}
                  <span lang="en">
                    ({x.factIds.map((id) => factLabel.get(id) ?? id).join('; ')})
                  </span>
                </li>
              ))}
            </ol>
          </details>
        </div>
      ) : null}
    </section>
  );
}

interface PublicAudio {
  id: string;
  form: 'radioLoop' | 'netReadout';
  language: 'en' | 'es';
  script: string;
  mimeType: string;
  bytes: number;
  provider: string;
  model: string;
  createdAt: string;
  clearedForAir: { by: string; at: string } | null;
}
const SPOKEN = { radioLoop: 'Radio loop (TIS)', netReadout: 'Amateur radio net read-out' } as const;

/**
 * PUB-14: the AI voice speaks the script the PIO approves (the rules' text,
 * changed as they need) into an audio file. Each file is listed with its
 * transcript. It is downloaded for air only once someone has played it to the
 * end and cleared it, with a reason (GATE-08): Clear stays off until then.
 */
function RadioAudio({
  siteId,
  site,
  drafts,
}: {
  siteId: string;
  site: string;
  drafts: AlertDraft[];
}) {
  const { rows, error, reload } = useList<PublicAudio>(`/alerts/audio?siteId=${siteId}`);
  const [form, setForm] = useState<'radioLoop' | 'netReadout'>('radioLoop');
  const [language, setLanguage] = useState<'en' | 'es'>('en');
  const rulesText = (f: typeof form, l: typeof language) =>
    drafts.find((d) => d.lang === l)?.[f] ?? '';
  const [script, setScript] = useState(() => rulesText('radioLoop', 'en'));
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'error' | 'success'; text: string } | null>(null);
  const [playing, setPlaying] = useState<Record<string, string>>({});
  const [heard, setHeard] = useState<Record<string, boolean>>({});

  const choose = (f: typeof form, l: typeof language) => {
    setForm(f);
    setLanguage(l);
    setScript(rulesText(f, l));
  };
  const make = async () => {
    setBusy(true);
    setMsg(null);
    try {
      await api('/alerts/audio', { body: { siteId, form, language, script } });
      setMsg({
        kind: 'success',
        text: 'Audio file made. Play it through before it goes on the air.',
      });
      reload();
    } catch (err) {
      setMsg({ kind: 'error', text: describeFailure(err) });
    } finally {
      setBusy(false);
    }
  };
  const play = async (a: PublicAudio) => {
    try {
      const blob = await fetchBlob(`/alerts/audio/${a.id}/file?for=listening`);
      setPlaying((p) => ({ ...p, [a.id]: URL.createObjectURL(blob) }));
    } catch (err) {
      setMsg({ kind: 'error', text: describeFailure(err) });
    }
  };
  const clear = async (a: PublicAudio) => {
    setMsg(null);
    try {
      await api(`/alerts/audio/${a.id}/clear`, { body: { heardToTheEnd: true } });
      setMsg({ kind: 'success', text: 'Cleared for air. The file can now be downloaded.' });
      reload();
    } catch (err) {
      setMsg({ kind: 'error', text: describeFailure(err) });
    }
  };
  const fileName = (a: PublicAudio) =>
    `${a.form === 'netReadout' ? 'net-readout' : 'radio-loop'}-${a.language}.${a.mimeType === 'audio/wav' ? 'wav' : 'mp3'}`;

  return (
    <section aria-labelledby="radio-audio-h">
      <h3 id="radio-audio-h">Radio audio</h3>
      <p>
        The AI voice reads the script below for {site} into an audio file for the county's
        Travelers' Information Station or an amateur radio net. The file opens by saying the voice
        is computer-generated. Change the script as needed first. Before a file can be downloaded
        for the air, play it to the end and clear it.
      </p>
      <div className="form-grid">
        <Field label="Script">
          {({ id }) => (
            <select
              id={id}
              value={form}
              onChange={(e) => choose(e.target.value as typeof form, language)}
            >
              <option value="radioLoop">{SPOKEN.radioLoop}</option>
              <option value="netReadout">{SPOKEN.netReadout}</option>
            </select>
          )}
        </Field>
        <Field label="Spoken language">
          {({ id }) => (
            <select
              id={id}
              value={language}
              onChange={(e) => choose(form, e.target.value as typeof language)}
            >
              <option value="en">English</option>
              <option value="es">Spanish</option>
            </select>
          )}
        </Field>
      </div>
      <Field label="Script to speak">
        {({ id }) => (
          <textarea
            id={id}
            lang={language}
            rows={6}
            value={script}
            onChange={(e) => setScript(e.target.value)}
          />
        )}
      </Field>
      <Toolbar>
        <button
          type="button"
          onClick={make}
          disabled={busy || script.trim().length < 10 || script.length > 3800}
          aria-busy={busy}
        >
          {busy ? 'Making the audio file…' : 'Make the audio file with the AI voice'}
        </button>
      </Toolbar>
      {msg ? <Status kind={msg.kind}>{msg.text}</Status> : null}
      {error ? <Status kind="error">{error}</Status> : null}
      {rows?.length ? (
        <ul aria-label={`Audio files for ${site}`}>
          {rows.map((a) => (
            <li key={a.id}>
              <p>
                {SPOKEN[a.form]}, {a.language === 'es' ? 'Spanish' : 'English'}, made{' '}
                {fmt(a.createdAt)} by the AI voice ({a.provider}, {a.model});{' '}
                {Math.ceil(a.bytes / 1024)} KB.
              </p>
              <p id={`air-${a.id}`}>
                {a.clearedForAir
                  ? `Cleared for air ${fmt(a.clearedForAir.at)}.`
                  : heard[a.id]
                    ? 'Played to the end. Clear it for air if it says what the script says.'
                    : 'Not cleared for air yet: play it to the end first.'}
              </p>
              {playing[a.id] ? (
                <audio
                  controls
                  src={playing[a.id]}
                  aria-label={`${SPOKEN[a.form]}, ${a.language === 'es' ? 'Spanish' : 'English'}`}
                  onEnded={() => setHeard((h) => ({ ...h, [a.id]: true }))}
                />
              ) : null}
              <Toolbar>
                {playing[a.id] ? null : (
                  <button type="button" onClick={() => play(a)}>
                    Play
                  </button>
                )}
                {a.clearedForAir ? (
                  <button
                    type="button"
                    className="link"
                    onClick={() =>
                      download(`/alerts/audio/${a.id}/file`, fileName(a)).catch((err) =>
                        setMsg({ kind: 'error', text: describeFailure(err) }),
                      )
                    }
                  >
                    Download for air
                  </button>
                ) : (
                  <button
                    type="button"
                    disabled={!heard[a.id]}
                    aria-describedby={`air-${a.id}`}
                    onClick={() => void clear(a)}
                  >
                    Clear for air
                  </button>
                )}
              </Toolbar>
              <details>
                <summary>Transcript</summary>
                <p lang={a.language}>{a.script}</p>
              </details>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

const CARD_W = 1200;
const CARD_H = 630;
const CARD_PAD = 60;

/** Words into lines that fit the width at a font size (an even estimate of glyph width). */
function wrapText(text: string, size: number, width = CARD_W - 2 * CARD_PAD): string[] {
  const max = Math.max(8, Math.floor(width / (size * 0.53)));
  const lines: string[] = [];
  let line = '';
  for (const word of text.split(/\s+/).filter(Boolean)) {
    if (!line) line = word;
    else if (`${line} ${word}`.length <= max) line = `${line} ${word}`;
    else {
      lines.push(line);
      line = word;
    }
  }
  if (line) lines.push(line);
  return lines;
}

/**
 * PUB-12: a simple graphic for the social post, 1200 by 630, dark text on
 * white with the heading on a dark band (contrast well over 4.5:1). Nothing
 * on it is only in the picture: its alt text says all of it, and the PIO
 * posts the two together.
 */
function SocialCard({ card, lang }: { card: AlertCard; lang: 'en' | 'es' }) {
  const titleId = useId();
  const ref = useRef<SVGSVGElement>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const font = 'system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif';
  const footerLines = wrapText(card.footer, 26).slice(0, 3);
  const footerTop = CARD_H - 40 - footerLines.length * 34;
  const blocks: { text: string; size: number; weight: number; color: string; y: number }[] = [];
  let y = 120 + 80;
  const add = (text: string, size: number, weight: number, color: string, maxLines: number) => {
    for (const line of wrapText(text, size).slice(0, maxLines)) {
      if (y > footerTop - 24) return;
      blocks.push({ text: line, size, weight, color, y });
      y += size * 1.25;
    }
  };
  add(card.status, 64, 700, '#0b3d5c', 1);
  add(card.name, 52, 700, '#111111', 2);
  y += 8;
  for (const d of card.details) add(d, 32, 400, '#222222', 2);
  const save = async () => {
    setMsg(null);
    const svg = ref.current;
    if (!svg) return;
    try {
      const xml = new XMLSerializer().serializeToString(svg);
      const url = URL.createObjectURL(new Blob([xml], { type: 'image/svg+xml' }));
      const img = new Image();
      await new Promise<void>((resolve, reject) => {
        img.onload = () => resolve();
        img.onerror = () => reject(new Error('The image could not be drawn.'));
        img.src = url;
      });
      const canvas = document.createElement('canvas');
      canvas.width = CARD_W;
      canvas.height = CARD_H;
      canvas.getContext('2d')!.drawImage(img, 0, 0);
      URL.revokeObjectURL(url);
      const png = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
      if (!png) throw new Error('The image could not be saved.');
      const a = document.createElement('a');
      a.href = URL.createObjectURL(png);
      a.download = `site-post-${lang}.png`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
    } catch (err) {
      setMsg(describeFailure(err));
    }
  };
  const language = lang === 'es' ? 'Spanish' : 'English';
  return (
    <figure className="social-card">
      <svg
        ref={ref}
        xmlns="http://www.w3.org/2000/svg"
        viewBox={`0 0 ${CARD_W} ${CARD_H}`}
        width={CARD_W}
        height={CARD_H}
        role="img"
        aria-labelledby={titleId}
        lang={lang}
        style={{ width: '100%', maxWidth: 600, height: 'auto' }}
      >
        <title id={titleId}>{card.alt}</title>
        <rect width={CARD_W} height={CARD_H} fill="#ffffff" />
        <rect width={CARD_W} height={120} fill="#0b3d5c" />
        <text x={CARD_PAD} y={78} fill="#ffffff" fontSize={40} fontWeight={600} fontFamily={font}>
          {card.heading}
        </text>
        {blocks.map((b, i) => (
          <text
            key={i}
            x={CARD_PAD}
            y={b.y}
            fill={b.color}
            fontSize={b.size}
            fontWeight={b.weight}
            fontFamily={font}
          >
            {b.text}
          </text>
        ))}
        <rect y={footerTop - 40} width={CARD_W} height={CARD_H - footerTop + 40} fill="#eef1f5" />
        {footerLines.map((line, i) => (
          <text
            key={i}
            x={CARD_PAD}
            y={footerTop + i * 34}
            fill="#111111"
            fontSize={26}
            fontFamily={font}
          >
            {line}
          </text>
        ))}
      </svg>
      <figcaption>
        <strong>{language}.</strong> Alt text to post with it: <span lang={lang}>{card.alt}</span>
      </figcaption>
      <Toolbar>
        <button type="button" onClick={save}>
          Download the {language} image (PNG)
        </button>
      </Toolbar>
      {msg ? <Status kind="error">{msg}</Status> : null}
    </figure>
  );
}
