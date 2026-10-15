/**
 * "Offer a place for disaster use" (layer-7 task D; REC-01, EQ-06, WCAG 2.2
 * AA): a school, place of worship, business or community group tells the
 * county about a space. The offer goes to the county's approval queue; the
 * page says so and echoes nothing back. Questions with "yes / no / not sure"
 * are radio groups with a legend; anything unknown can stay blank (REC-10).
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
      ` ${o.authorized}`,
    ),
    el('div', { class: 'actions' }, el('button', { type: 'submit' }, o.submit)),
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
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const authorized = (form.elements.namedItem('authorized') as HTMLInputElement).checked;
    if (
      !value('name') ||
      !value('line1') ||
      !value('yourName') ||
      !(value('phone') || value('email')) ||
      !authorized
    ) {
      status.replaceChildren(el('p', { role: 'alert', class: 'danger' }, o.failed));
      return;
    }
    status.replaceChildren(el('p', {}, o.sending));
    const body = {
      executionId: crypto.randomUUID(),
      facility: {
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
      },
      submitter: {
        name: value('yourName'),
        ...(value('organization') ? { organization: value('organization') } : {}),
        ...(value('phone') ? { phone: value('phone') } : {}),
        ...(value('email') ? { email: value('email') } : {}),
      },
      authorized: true,
    };
    void fetch(`/api/public/facilities/${encodeURIComponent(tenant)}/register?lang=${lang}`, {
      method: 'POST',
      credentials: 'omit',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
      .then((res) => {
        if (!res.ok) throw new Error(`offer ${res.status}`);
        form.replaceChildren(
          el('p', { role: 'status', class: 'thanks' }, o.thanks),
          el('p', {}, el('a', { href: backHref }, o.back)),
        );
      })
      .catch(() => status.replaceChildren(el('p', { role: 'alert', class: 'danger' }, o.failed)));
  });
  return form;
}
