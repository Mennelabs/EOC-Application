/**
 * Resources (plan console screen 8; BRD:FR-16.01–16.05, PUB-06, PUB-18,
 * ACC-35/49/51): hotlines, programs, deadlines and guidance with English and
 * Spanish text, each marked human-reviewed by the person saving it; the
 * accessibility check of the HTML shown before publishing; review and expiry
 * dates; the outside-link check; publish with the approval dialog.
 */
import { useState, type FormEvent } from 'react';
import { api, describeFailure } from '../api/client.ts';
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
  texts: Text[];
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
            render: (r) => r.texts.find((t) => t.locale === 'en')?.title ?? r.slug,
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
