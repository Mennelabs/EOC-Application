/**
 * "Sign up to volunteer" (FL:FR-20, EQ-06, WCAG 2.2 AA): a walk-up volunteer
 * opens the code at the volunteer desk on their own phone, fills in who they
 * are and the skills they have (from a fixed list, checked later by staff),
 * and reads and accepts the county's waiver when the county gave its text;
 * otherwise they sign it at the desk. The answer is a desk code and nothing
 * else; staff at the desk finish the sign-up. The link is checked before the
 * form is shown; a closed or expired one says to ask at the desk.
 */
import type { Lang, Strings } from './i18n.ts';

type El = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs?: Record<string, string>,
  ...children: (Node | string | null | undefined)[]
) => HTMLElementTagNameMap[K];

interface Link {
  eventName: string;
  waiverVersion: string;
  waiver: string | null;
  waiverLang: string | null;
  skills: string[];
}

const fill = (text: string, values: Record<string, string>) =>
  text.replace(/\{(\w+)\}/g, (_, k: string) => values[k] ?? '');

export function volunteerForm(
  el: El,
  tenant: string,
  token: string,
  lang: Lang,
  t: Strings,
): HTMLElement {
  const v = t.volunteer;
  const box = el('div', { class: 'volunteer' }, el('p', { role: 'status' }, v.loading));
  const path = `/api/public/volunteers/${encodeURIComponent(tenant)}/join/${encodeURIComponent(token)}`;
  const gone = () => box.replaceChildren(el('p', { role: 'alert', class: 'danger' }, v.linkGone));
  void fetch(`${path}?lang=${lang}`, { credentials: 'omit' })
    .then(async (res) => {
      if (!res.ok) throw new Error('gone');
      box.replaceChildren(form(el, path, lang, t, (await res.json()) as Link, box));
    })
    .catch(gone);
  return box;
}

function form(el: El, path: string, lang: Lang, t: Strings, link: Link, box: HTMLElement) {
  const v = t.volunteer;
  const field = (id: string, label: string, attrs: Record<string, string> = {}) =>
    el(
      'div',
      { class: 'field' },
      el('label', { for: id }, label),
      el('input', { id, name: id, ...attrs }),
    );
  const status = el('div', { 'aria-live': 'polite', class: 'offer-status' });
  const waiver = link.waiver
    ? el(
        'fieldset',
        {},
        el('legend', {}, fill(v.waiver, { version: link.waiverVersion })),
        link.waiverLang && link.waiverLang !== lang
          ? el('p', { class: 'hint' }, v.waiverOtherLanguage)
          : null,
        el(
          'div',
          { class: 'waiver-text', ...(link.waiverLang ? { lang: link.waiverLang } : {}) },
          ...link.waiver
            .split(/\n\s*\n/)
            .map((p) => p.trim())
            .filter(Boolean)
            .map((p) => el('p', {}, p)),
        ),
        el(
          'label',
          { class: 'choice' },
          el('input', { type: 'checkbox', name: 'accept', id: 'accept', required: 'required' }),
          ` ${v.accept}`,
        ),
      )
    : el('p', { class: 'hint' }, fill(v.atDesk, { version: link.waiverVersion }));
  const f = el(
    'form',
    { class: 'offer', novalidate: 'novalidate' },
    el('p', { class: 'intro' }, fill(v.forEvent, { event: link.eventName })),
    el(
      'fieldset',
      {},
      el('legend', {}, v.you),
      field('name', v.name, {
        required: 'required',
        autocomplete: 'name',
        maxlength: '120',
      }),
      el('p', { id: 'reach-hint', class: 'hint' }, v.reach),
      field('phone', v.phone, {
        type: 'tel',
        autocomplete: 'tel',
        maxlength: '20',
        'aria-describedby': 'reach-hint',
      }),
      field('email', v.email, {
        type: 'email',
        autocomplete: 'email',
        maxlength: '200',
        'aria-describedby': 'reach-hint',
      }),
      field('agency', v.agency, { autocomplete: 'organization', maxlength: '200' }),
    ),
    el(
      'fieldset',
      {},
      el('legend', {}, v.skills),
      ...link.skills.map((k) =>
        el(
          'label',
          { class: 'choice' },
          el('input', { type: 'checkbox', name: 'skill', value: k }),
          ` ${v.skillNames[k] ?? k}`,
        ),
      ),
    ),
    waiver,
    el('p', { class: 'hint' }, v.backgroundCheck),
    el('div', { class: 'actions' }, el('button', { type: 'submit' }, v.submit)),
    status,
  );
  const value = (name: string) =>
    ((f.elements.namedItem(name) as HTMLInputElement | null)?.value ?? '').trim();
  const executionId = crypto.randomUUID();
  f.addEventListener('submit', (e) => {
    e.preventDefault();
    const accepted = (f.elements.namedItem('accept') as HTMLInputElement | null)?.checked ?? false;
    const name = f.elements.namedItem('name') as HTMLInputElement;
    const bad = value('name').length < 2 || (link.waiver !== null && !accepted);
    name.setAttribute('aria-invalid', String(value('name').length < 2));
    if (bad) {
      status.replaceChildren(el('p', { role: 'alert', class: 'danger' }, v.failed));
      return;
    }
    status.replaceChildren(el('p', {}, v.sending));
    const skills = [...f.querySelectorAll<HTMLInputElement>('input[name="skill"]:checked')].map(
      (i) => i.value,
    );
    const body = {
      executionId,
      person: {
        name: value('name'),
        ...(value('phone') ? { phone: value('phone') } : {}),
        ...(value('email') ? { email: value('email') } : {}),
        ...(value('agency') ? { agency: value('agency') } : {}),
      },
      skills,
      ...(link.waiver ? { waiverAccepted: true } : {}),
    };
    void fetch(`${path}?lang=${lang}`, {
      method: 'POST',
      credentials: 'omit',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
      .then(async (res) => {
        if (res.status === 404) throw new Error('gone');
        if (!res.ok) throw new Error(`signup ${res.status}`);
        const { deskCode } = (await res.json()) as { deskCode: string };
        const code = el('p', { class: 'desk-code', id: 'desk-code', tabindex: '-1' }, deskCode);
        box.replaceChildren(
          el('p', { role: 'status', class: 'thanks' }, v.done),
          code,
          el('p', {}, v.doneAfter),
        );
        code.focus();
      })
      .catch((err: unknown) =>
        status.replaceChildren(
          el(
            'p',
            { role: 'alert', class: 'danger' },
            (err as Error).message === 'gone' ? v.linkGone : v.failed,
          ),
        ),
      );
  });
  return f;
}
