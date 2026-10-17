/**
 * Resources (plan console screen 8; BRD:FR-16.01–16.05, PUB-06, PUB-18,
 * ACC-35/49/51): hotlines, programs, deadlines and guidance with English and
 * Spanish text, each marked human-reviewed by the person saving it; the
 * accessibility check of the HTML shown before publishing; review and expiry
 * dates; the outside-link check; publish with the approval dialog. A
 * resource may carry a decorative thumbnail (FR-16.01): uploaded here, shown
 * to the public from the next publish on, removed from the public at once.
 */
import { useState, type FormEvent } from 'react';
import { api, describeFailure, upload } from '../api/client.ts';
import { useImage } from '../ui/badge-photo.tsx';
import { DataTable, Field, Status, fmt } from '../ui/primitives.tsx';
import { useList } from './admin.tsx';

interface Text {
  locale: string;
  title: string;
  summary: string | null;
  bodyHtml: string;
  reviewedAt: string | null;
  problems: string[];
}
interface Resource {
  id: string;
  version: number;
  slug: string;
  type: string;
  category: string;
  status: string;
  expiresAt: string | null;
  reviewAt: string | null;
  referenceUrl: string | null;
  linkStatus: string;
  linkCheckedAt: string | null;
  published: boolean;
  thumbnail: {
    uploaded: boolean;
    uploadedAt: string | null;
    publicPicture: boolean;
    waitingForPublish: boolean;
  };
  texts: Text[];
}

const titleOf = (r: Resource) => r.texts.find((t) => t.locale === 'en')?.title ?? r.slug;

function thumbnailState(r: Resource): string {
  if (!r.thumbnail.uploaded) return 'None';
  if (r.thumbnail.waitingForPublish)
    return r.published ? 'New picture: shown after the next publish' : 'Shown once published';
  return r.published ? 'Shown to the public' : 'Shown once published';
}

/** FR-16.01: the resource's decorative picture: preview, replace, remove. */
function ThumbnailPanel({ r, onChanged }: { r: Resource; onChanged: () => void }) {
  const title = titleOf(r);
  const preview = useImage(
    r.thumbnail.uploaded ? `/resources/${r.id}/thumbnail?v=${r.version}` : null,
  );
  const [msg, setMsg] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);
  const send = async (file: File | undefined) => {
    if (!file) return;
    setMsg(null);
    try {
      await upload(`/resources/${r.id}/thumbnail`, file, file.type || 'image/jpeg', {
        version: r.version,
      });
      setMsg({
        kind: 'success',
        text: r.published
          ? 'Picture saved, cropped to 3:2. The public sees it after you publish again.'
          : 'Picture saved, cropped to 3:2. The public sees it once the resource is published.',
      });
      onChanged();
    } catch (e) {
      setMsg({ kind: 'error', text: describeFailure(e) });
    }
  };
  const remove = async () => {
    setMsg(null);
    try {
      await api(`/resources/${r.id}/thumbnail`, { method: 'DELETE', version: r.version });
      setMsg({ kind: 'success', text: 'Picture removed, from the public page too.' });
      onChanged();
    } catch (e) {
      setMsg({ kind: 'error', text: describeFailure(e) });
    }
  };
  return (
    <section className="panel" aria-labelledby="thumb-h">
      <h2 id="thumb-h">Picture for {title}</h2>
      <p className="hint">
        Optional and decorative: screen readers skip it, so the title and text must say everything.
        Pictures of people or homes that could identify someone do not belong here.
      </p>
      {msg ? <Status kind={msg.kind}>{msg.text}</Status> : null}
      <p>{thumbnailState(r)}</p>
      {preview ? (
        <img src={preview} alt={`Picture uploaded for ${title}`} width={240} height={160} />
      ) : null}
      <div className="actions" style={{ justifyContent: 'flex-start' }}>
        <label>
          {r.thumbnail.uploaded ? 'Replace the picture' : 'Choose a picture'} (JPEG, PNG or WebP)
          <input
            type="file"
            accept="image/jpeg,image/png,image/webp"
            onChange={(e) => void send(e.target.files?.[0])}
          />
        </label>
        {r.thumbnail.uploaded ? (
          <button type="button" onClick={() => void remove()}>
            Remove the picture
          </button>
        ) : null}
      </div>
    </section>
  );
}

const TYPES = ['hotline', 'program', 'deadline', 'guidance', 'link', 'document'];
const blankText = { title: '', summary: '', bodyHtml: '<p></p>', humanReviewed: false };
const blank = {
  type: 'program',
  category: 'help',
  referenceUrl: '',
  expiresAt: '',
  en: { ...blankText },
  es: { ...blankText },
};

function TextFields({
  lang,
  value,
  onChange,
}: {
  lang: 'en' | 'es';
  value: typeof blankText;
  onChange: (v: typeof blankText) => void;
}) {
  const name = lang === 'en' ? 'English' : 'Spanish';
  return (
    <fieldset>
      <legend>{name}</legend>
      <Field label={`${name} title`}>
        {({ id }) => (
          <input
            id={id}
            value={value.title}
            onChange={(e) => onChange({ ...value, title: e.target.value })}
            required={lang === 'en'}
            lang={lang}
          />
        )}
      </Field>
      <Field label={`${name} summary`}>
        {({ id }) => (
          <input
            id={id}
            value={value.summary}
            onChange={(e) => onChange({ ...value, summary: e.target.value })}
            lang={lang}
          />
        )}
      </Field>
      <Field
        label={`${name} body (HTML)`}
        hint="Paragraphs, lists, headings from level 2 and links with real text. No PDF as the only way in."
      >
        {({ id, describedBy }) => (
          <textarea
            id={id}
            aria-describedby={describedBy}
            rows={5}
            value={value.bodyHtml}
            onChange={(e) => onChange({ ...value, bodyHtml: e.target.value })}
            lang={lang}
          />
        )}
      </Field>
      <Field
        label={`I reviewed the ${name} text`}
        hint="Safety-critical text is human-reviewed before it is published (PUB-06, ACC-35)."
      >
        {({ id, describedBy }) => (
          <input
            id={id}
            type="checkbox"
            aria-describedby={describedBy}
            checked={value.humanReviewed}
            onChange={(e) => onChange({ ...value, humanReviewed: e.target.checked })}
          />
        )}
      </Field>
    </fieldset>
  );
}

export function ResourcesScreen() {
  const { rows, error, reload } = useList<Resource>('/resources?limit=200');
  const [form, setForm] = useState(blank);
  const [msg, setMsg] = useState<string | null>(null);
  const [pictureFor, setPictureFor] = useState<string | null>(null);
  const picked = rows?.find((r) => r.id === pictureFor) ?? null;
  const create = async (e: FormEvent) => {
    e.preventDefault();
    setMsg(null);
    const texts: Record<string, unknown> = { en: form.en };
    if (form.es.title) texts['es'] = form.es;
    try {
      await api('/resources', {
        body: {
          type: form.type,
          category: form.category,
          referenceUrl: form.referenceUrl || null,
          expiresAt: form.expiresAt ? new Date(form.expiresAt).toISOString() : null,
          texts,
        },
      });
      setMsg(
        'Resource saved as a draft. Publish it when every text is reviewed and the check passes.',
      );
      setForm(blank);
      reload();
    } catch (err) {
      setMsg(describeFailure(err));
    }
  };
  const act = async (r: Resource, verb: string) => {
    setMsg(null);
    try {
      const out = await api<Resource>(`/resources/${r.id}/${verb}`, { body: {} });
      setMsg(verb === 'check-link' ? `Link ${out.linkStatus}.` : `${r.slug}: ${verb}ed.`);
      reload();
    } catch (err) {
      setMsg(describeFailure(err));
    }
  };
  return (
    <section aria-labelledby="res-h">
      <h1 id="res-h">Resources</h1>
      {error ? <Status kind="error">{error}</Status> : null}
      {msg ? <Status kind="info">{msg}</Status> : null}
      <DataTable
        caption="Resources"
        rows={rows ?? []}
        rowKey={(r) => r.id}
        columns={[
          {
            key: 'title',
            header: 'Title',
            render: (r) => titleOf(r),
          },
          { key: 'type', header: 'Type', render: (r) => r.type },
          { key: 'status', header: 'Status', render: (r) => r.status },
          {
            key: 'langs',
            header: 'Languages',
            render: (r) =>
              r.texts.map((t) => `${t.locale}${t.reviewedAt ? ' ✓' : ' (unreviewed)'}`).join(', '),
          },
          {
            key: 'problems',
            header: 'Accessibility',
            render: (r) => r.texts.flatMap((t) => t.problems).join('; ') || 'ok',
          },
          { key: 'expires', header: 'Expires', render: (r) => fmt(r.expiresAt) },
          { key: 'picture', header: 'Picture', render: (r) => thumbnailState(r) },
          {
            key: 'link',
            header: 'Outside link',
            render: (r) =>
              r.referenceUrl
                ? `${r.linkStatus}${r.linkCheckedAt ? ` (${fmt(r.linkCheckedAt)})` : ''}`
                : '—',
          },
          {
            key: 'act',
            header: 'Actions',
            render: (r) => (
              <span className="actions">
                <button type="button" onClick={() => setPictureFor(r.id)}>
                  Picture for {titleOf(r)}
                </button>
                {r.referenceUrl ? (
                  <button type="button" onClick={() => act(r, 'check-link')}>
                    Check link
                  </button>
                ) : null}
                {r.published ? (
                  <button type="button" onClick={() => act(r, 'unpublish')}>
                    Unpublish
                  </button>
                ) : (
                  <button type="button" className="primary" onClick={() => act(r, 'publish')}>
                    Publish…
                  </button>
                )}
              </span>
            ),
          },
        ]}
      />
      {picked ? <ThumbnailPanel r={picked} onChanged={reload} /> : null}
      <h2>Add a resource</h2>
      <form onSubmit={create} className="form-grid">
        <Field label="Type">
          {({ id }) => (
            <select
              id={id}
              value={form.type}
              onChange={(e) => setForm({ ...form, type: e.target.value })}
            >
              {TYPES.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          )}
        </Field>
        <Field label="Category">
          {({ id }) => (
            <input
              id={id}
              value={form.category}
              onChange={(e) => setForm({ ...form, category: e.target.value })}
            />
          )}
        </Field>
        <Field label="Outside link" hint="Checked before publishing; a broken link is flagged.">
          {({ id, describedBy }) => (
            <input
              id={id}
              aria-describedby={describedBy}
              type="url"
              value={form.referenceUrl}
              onChange={(e) => setForm({ ...form, referenceUrl: e.target.value })}
            />
          )}
        </Field>
        <Field
          label="Expires on"
          hint="After this date the public page says the information expired."
        >
          {({ id, describedBy }) => (
            <input
              id={id}
              aria-describedby={describedBy}
              type="date"
              value={form.expiresAt}
              onChange={(e) => setForm({ ...form, expiresAt: e.target.value })}
            />
          )}
        </Field>
        <TextFields lang="en" value={form.en} onChange={(en) => setForm({ ...form, en })} />
        <TextFields lang="es" value={form.es} onChange={(es) => setForm({ ...form, es })} />
        <div className="actions">
          <button type="submit" className="primary">
            Save draft
          </button>
        </div>
      </form>
    </section>
  );
}
