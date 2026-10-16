/**
 * "Offer a place for disaster use" (layer-7 task D; REC-01, EQ-06, WCAG 2.2
 * AA): a school, place of worship, business or community group tells the
 * county about a space. The offer goes to the county's approval queue; the
 * page says so and echoes nothing back. Questions with "yes / no / not sure"
 * are radio groups with a legend; anything unknown can stay blank (REC-10).
 *
 * With `update` (REC-01), the same form is an owner's yearly re-check: it is
 * filled with what the county has (never contacts), and the owner sends the
 * corrections or says nothing has changed. Either way it is a proposal the
 * county reviews; the link works once.
 */
import type { Lang, Strings } from './i18n.ts';

type El = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs?: Record<string, string>,
  ...children: (Node | string | null | undefined)[]
) => HTMLElementTagNameMap[K];

export function offerForm(
  el: El,
  tenant: string,
  lang: Lang,
  t: Strings,
  backHref: string,
  update: string | null = null,
): HTMLElement {
  const o = t.offer;
  const field = (id: string, label: string, attrs: Record<string, string> = {}) =>
    el(
      'div',
      { class: 'field' },
      el('label', { for: id }, label),
      el('input', { id, name: id, ...attrs }),
    );
  const triple = (name: string, legend: string) =>
    el(
      'fieldset',
      {},
      el('legend', {}, legend),
      ...(['yes', 'no', 'unsure'] as const).map((v) =>
        el(
          'label',
          { class: 'choice' },
          el('input', {
            type: 'radio',
            name,
            value: v,
            ...(v === 'unsure' ? { checked: 'checked' } : {}),
          }),
          ` ${o[v]}`,
        ),
      ),
    );
  const kind = el('select', { id: 'kind', name: 'kind' });
  for (const [k, label] of Object.entries(o.kinds)) kind.append(el('option', { value: k }, label));
  const power = el('select', { id: 'power', name: 'power' }, el('option', { value: '' }, o.unsure));
  for (const [k, label] of Object.entries(o.powers))
    power.append(el('option', { value: k }, label));
  const status = el('div', { 'aria-live': 'polite', class: 'offer-status' });
  const form = el(
    'form',
    { class: 'offer', novalidate: 'novalidate' },
    el(
      'fieldset',
      {},
      el('legend', {}, o.place),
      field('name', o.name, {
        required: 'required',
        autocomplete: 'organization',
        maxlength: '200',
      }),
      el('div', { class: 'field' }, el('label', { for: 'kind' }, o.kind), kind),
      field('line1', o.line1, { required: 'required', autocomplete: 'address-line1' }),
      field('city', o.city, { autocomplete: 'address-level2' }),
      field('postal', o.postal, { autocomplete: 'postal-code', inputmode: 'numeric' }),
      field('sqft', o.sqft, { inputmode: 'numeric' }),
      triple('ada', o.ada),
      el('div', { class: 'field' }, el('label', { for: 'power' }, o.power), power),
      triple('kitchen', o.kitchen),
      field('showers', o.showers, { inputmode: 'numeric' }),
      field('parking', o.parking, { inputmode: 'numeric' }),
      triple('truck', o.truck),
      el(
        'div',
        { class: 'field' },
        el('label', { for: 'notes' }, o.notes),
        el('textarea', { id: 'notes', name: 'notes', rows: '3', maxlength: '2000' }),
      ),
    ),
    el(
      'fieldset',
      {},
      el('legend', {}, o.you),
      el('p', { id: 'reach-hint', class: 'hint' }, o.reach),
      field('yourName', o.yourName, { required: 'required', autocomplete: 'name' }),
      field('organization', o.organization, { autocomplete: 'organization' }),
      field('phone', o.phone, {
        type: 'tel',
        autocomplete: 'tel',
        'aria-describedby': 'reach-hint',
      }),
      field('email', o.email, {
        type: 'email',
        autocomplete: 'email',
        'aria-describedby': 'reach-hint',
      }),
    ),
    el(
      'label',
      { class: 'choice' },
      el('input', { type: 'checkbox', name: 'authorized', id: 'authorized', required: 'required' }),
      ` ${update ? o.authorizedUpdate : o.authorized}`,
    ),
    el(
      'div',
      { class: 'actions' },
      el('button', { type: 'submit' }, update ? o.submitUpdate : o.submit),
      update ? el('button', { type: 'button', id: 'unchanged' }, o.unchanged) : null,
    ),
    status,
  );
  const value = (name: string) =>
    ((form.elements.namedItem(name) as HTMLInputElement | null)?.value ?? '').trim();
  const radio = (name: string) => {
    const v = (form.querySelector(`input[name="${name}"]:checked`) as HTMLInputElement | null)
      ?.value;
    return v === 'yes' ? true : v === 'no' ? false : null;
  };
  const num = (name: string) =>
    value(name) && /^\d+$/.test(value(name)) ? Number(value(name)) : null;
  const send = (unchanged: boolean) => {
    const authorized = (form.elements.namedItem('authorized') as HTMLInputElement).checked;
    if (
      (!unchanged && (!value('name') || !value('line1'))) ||
      !value('yourName') ||
      !(value('phone') || value('email')) ||
      !authorized
    ) {
      status.replaceChildren(el('p', { role: 'alert', class: 'danger' }, o.failed));
      return;
    }
    status.replaceChildren(el('p', {}, o.sending));
    const facility = {
      name: value('name'),
      kind: value('kind'),
      address: {
        line1: value('line1'),
        city: value('city') || null,
        postal: value('postal') || null,
      },
      sqft: num('sqft'),
      ada: radio('ada'),
      powerBackup: value('power') || null,
      kitchen: radio('kitchen'),
      showers: num('showers'),
      parkingSpaces: num('parking'),
      truckAccess: radio('truck'),
      ...(value('notes') ? { notes: value('notes') } : {}),
    };
    const submitter = {
      name: value('yourName'),
      ...(value('organization') ? { organization: value('organization') } : {}),
      ...(value('phone') ? { phone: value('phone') } : {}),
      ...(value('email') ? { email: value('email') } : {}),
    };
    const executionId = crypto.randomUUID();
    const [path, body] = update
      ? [
          `/api/public/facilities/${encodeURIComponent(tenant)}/update/${encodeURIComponent(update)}`,
          { executionId, unchanged, ...(unchanged ? {} : { facility }), submitter },
        ]
      : [
          `/api/public/facilities/${encodeURIComponent(tenant)}/register`,
          { executionId, facility, submitter, authorized: true },
        ];
    void fetch(`${path}?lang=${lang}`, {
      method: 'POST',
      credentials: 'omit',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
      .then((res) => {
        if (res.status === 404 && update) throw new Error('gone');
        if (!res.ok) throw new Error(`offer ${res.status}`);
        form.replaceChildren(
          el(
            'p',
            { role: 'status', class: 'thanks' },
            update ? (unchanged ? o.thanksUnchanged : o.thanksUpdate) : o.thanks,
          ),
          el('p', {}, el('a', { href: backHref }, o.back)),
        );
      })
      .catch((err: unknown) =>
        status.replaceChildren(
          el(
            'p',
            { role: 'alert', class: 'danger' },
            (err as Error).message === 'gone' ? o.linkGone : o.failed,
          ),
        ),
      );
  };
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    send(false);
  });
  form.querySelector('#unchanged')?.addEventListener('click', () => send(true));

  if (update) {
    // REC-01: what the county has for the place; the link is checked before anything is shown.
    const set = (name: string, v: string | number | null | undefined) => {
      const input = form.elements.namedItem(name) as HTMLInputElement | HTMLSelectElement | null;
      if (input && v !== null && v !== undefined) input.value = String(v);
    };
    const pick = (name: string, v: boolean | null) => {
      const want = v === true ? 'yes' : v === false ? 'no' : 'unsure';
      const r = form.querySelector(`input[name="${name}"][value="${want}"]`) as HTMLInputElement;
      if (r) r.checked = true;
    };
    status.replaceChildren(el('p', {}, o.loading));
    void fetch(
      `/api/public/facilities/${encodeURIComponent(tenant)}/update/${encodeURIComponent(update)}?lang=${lang}`,
      { credentials: 'omit' },
    )
      .then(async (res) => {
        if (!res.ok) throw new Error('gone');
        const f = (await res.json()) as {
          name: string;
          kind: string;
          address: { line1: string | null; city: string | null; postal: string | null };
          sqft: number | null;
          ada: boolean | null;
          powerBackup: string | null;
          kitchen: boolean | null;
          showers: number | null;
          parkingSpaces: number | null;
          truckAccess: boolean | null;
        };
        set('name', f.name);
        set('kind', f.kind);
        set('line1', f.address.line1);
        set('city', f.address.city);
        set('postal', f.address.postal);
        set('sqft', f.sqft);
        pick('ada', f.ada);
        set('power', f.powerBackup);
        pick('kitchen', f.kitchen);
        set('showers', f.showers);
        set('parking', f.parkingSpaces);
        pick('truck', f.truckAccess);
        status.replaceChildren();
      })
      .catch(() =>
        form.replaceChildren(
          el('p', { role: 'alert', class: 'danger' }, o.linkGone),
          el('p', {}, el('a', { href: backHref }, o.back)),
        ),
      );
  }
  return form;
}
