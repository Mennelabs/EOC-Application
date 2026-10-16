/**
 * Public "Find help" page (PUB-07, PUB-02/04/15, PUB-18, A11Y-01, RULE-12,
 * SCL-06, SCL-13, EQ-06): no sign-in, list first, nearest first when the
 * visitor gives a ZIP, an address or a landmark, an optional map that loads
 * only on request, English and Spanish, printable with a poster view. Reads
 * the same published records as every other channel through the public API.
 * Everything the visitor types stays in the address bar; nothing is stored.
 */
import { langOf, strings, type Lang, type Strings } from './i18n.ts';
import { offerForm } from './offer.ts';
import './styles.css';

interface Address {
  line1: string | null;
  unit: string | null;
  city: string | null;
  state: string | null;
  postal: string | null;
}
export interface Site {
  id: string;
  slug: string;
  kind: string;
  name: string;
  status: string;
  address: Address | null;
  position: { lat: number; lon: number } | null;
  distanceKm: number | null;
  hours: Record<string, unknown>;
  services: string[];
  pets: string;
  accessibility: Record<string, unknown>;
  medicalPower: boolean | null;
  languages: string[];
  transit: string | null;
  directions: string | null;
  lastConfirmedAt: string | null;
  nextNearest: { id: string; slug: string; name: string; distanceKm: number | null } | null;
}
interface Resource {
  slug: string;
  type: string;
  category: string;
  title: string;
  summary: string | null;
  url: string;
  referenceUrl: string | null;
  expiresAt: string | null;
}
interface Help {
  tenant: { name: string; slug: string; locales: string[] };
  lang: string;
  generatedAt: string;
  near: { query: string; resolved: boolean; label: string | null; how: string } | null;
  sites: Site[];
  resources: Resource[];
  accessibility: { statement: string; supportPhone: string | null };
  notices: string[];
}
interface Config {
  productName?: string;
  countyName?: string;
  helpPhone?: string;
  tenant?: string;
}

const url = new URL(location.href);
const pathTenant = /^\/([a-z0-9-]+)\/help\/?$/i.exec(url.pathname)?.[1] ?? null;
const lang: Lang = langOf(url.searchParams.get('lang') ?? navigator.language);
let near = url.searchParams.get('near') ?? '';
let kind = url.searchParams.get('kind') ?? '';
let data: Help | null = null;
let mapOpen = false;
let config: Config = {};

const app = document.getElementById('app')!;

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
  ...children: (Node | string | null | undefined)[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  for (const c of children) if (c !== null && c !== undefined) node.append(c);
  return node;
}

function addressText(a: Address | null): string {
  if (!a) return '';
  return [a.line1, a.unit, a.city, a.state, a.postal].filter(Boolean).join(', ');
}
function hoursText(hours: Record<string, unknown>, t: Strings): string {
  if (hours['always'] === true) return t.hoursAlways;
  return Object.entries(hours)
    .filter(([, v]) => typeof v === 'string' && v)
    .map(([k, v]) => `${k}: ${v as string}`)
    .join('; ');
}
function shortTime(iso: string): string {
  return new Date(iso).toLocaleString(lang === 'es' ? 'es-US' : 'en-US', {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
}
function pageUrl(overrides: Record<string, string | null>): string {
  const u = new URL(location.href);
  for (const [k, v] of Object.entries(overrides))
    if (v === null || v === '') u.searchParams.delete(k);
    else u.searchParams.set(k, v);
  return u.pathname + u.search;
}

async function loadConfig(): Promise<Config> {
  try {
    const res = await fetch('/config.json', { cache: 'no-store' });
    return res.ok ? ((await res.json()) as Config) : {};
  } catch {
    return {};
  }
}

const CACHE_KEY = 'cg-help-last';
async function load(tenant: string): Promise<Help> {
  const q = new URLSearchParams({ lang });
  if (near) q.set('near', near);
  if (kind) q.set('kind', kind);
  const res = await fetch(`/api/public/help/${encodeURIComponent(tenant)}?${q}`, {
    credentials: 'omit',
  });
  if (!res.ok) throw new Error(`help ${res.status}`);
  const body = (await res.json()) as Help;
  try {
    sessionStorage.setItem(CACHE_KEY, JSON.stringify(body));
  } catch {
    /* storage may be unavailable; the page still works (SCL-06) */
  }
  return body;
}
function lastLoaded(): Help | null {
  try {
    const raw = sessionStorage.getItem(CACHE_KEY);
    return raw ? (JSON.parse(raw) as Help) : null;
  } catch {
    return null;
  }
}

function siteCard(s: Site, t: Strings): HTMLElement {
  const facts = el('dl');
  const row = (label: string, value: string | null | undefined) => {
    if (!value) return;
    facts.append(el('div', { class: 'row' }, el('dt', {}, label), el('dd', {}, value)));
  };
  row(t.hours, hoursText(s.hours, t));
  // Keys such as pet_area_outside read as words and wrap at 320 px (ACC-07).
  row(t.services, s.services.map((k) => k.replace(/_/g, ' ')).join(', ') || null);
  const access = Object.entries(s.accessibility)
    .filter(([, v]) => v === true)
    .map(([k]) => k.replace(/_/g, ' '))
    .join(', ');
  row(t.accessibility, access || null);
  row(t.medicalPower, s.medicalPower === null ? null : s.medicalPower ? '✓' : '—');
  row(t.languages, s.languages.join(', ') || null);
  row(t.transit, s.transit);
  row(t.directions, s.directions);
  row(t.lastConfirmed, s.lastConfirmedAt ? shortTime(s.lastConfirmedAt) : null);
  const status = el('span', { class: `status status-${s.status}` }, t.status[s.status] ?? s.status);
  const title = el('h3', { id: `site-${s.slug}` }, s.name, ' ', status);
  const meta = el(
    'p',
    { class: 'meta' },
    `${t.kind[s.kind] ?? s.kind}`,
    s.distanceKm !== null ? ` · ${t.distance(s.distanceKm)}` : '',
  );
  const addr = el('p', { class: 'addr' }, addressText(s.address));
  const pets = el('p', { class: 'pets' }, t.pets[s.pets] ?? '');
  const card = el(
    'article',
    { class: `site site-${s.status}`, 'aria-labelledby': `site-${s.slug}` },
    title,
    meta,
    addr,
    pets,
    facts,
  );
  if (s.nextNearest) {
    const link = el('a', { href: `#site-${s.nextNearest.slug}` }, s.nextNearest.name);
    card.append(
      el(
        'p',
        { class: 'next' },
        `${t.nextNearest}: `,
        link,
        s.nextNearest.distanceKm !== null ? ` (${t.distance(s.nextNearest.distanceKm)})` : '',
      ),
    );
  }
  return card;
}

interface AskAnswer {
  intent: string;
  answer: string;
  links: Record<string, string>;
  sites: { slug: string; name: string }[];
  resources: { slug: string; title: string; url: string }[];
}

/**
 * The public command coverage (CMD-19, ACC-31, AC-A08): a plain ask box beside
 * the list and the form, never instead of them. Published help, the form,
 * the resume page and the verified status page; nothing typed is kept.
 */
function askForm(tenant: string, t: Strings): HTMLElement {
  const form = el('form', { class: 'search ask' });
  const input = el('input', {
    type: 'text',
    name: 'ask',
    id: 'ask',
    autocomplete: 'off',
    'aria-describedby': 'ask-hint',
    maxlength: '500',
  });
  const out = el('div', { class: 'ask-answer', 'aria-live': 'polite' });
  form.append(
    el('label', { for: 'ask' }, t.askLabel),
    input,
    el('p', { id: 'ask-hint', class: 'hint' }, t.askHint),
    el('div', { class: 'actions' }, el('button', { type: 'submit' }, t.ask)),
    out,
  );
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    out.replaceChildren(el('p', {}, t.asking));
    void fetch(`/api/public/help/${encodeURIComponent(tenant)}/ask`, {
      method: 'POST',
      credentials: 'omit',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text, lang }),
    })
      .then(async (res) => {
        if (!res.ok) throw new Error(`ask ${res.status}`);
        const a = (await res.json()) as AskAnswer;
        const items = el('ul', {});
        for (const s of a.sites)
          items.append(el('li', {}, el('a', { href: `#site-${s.slug}` }, s.name)));
        for (const r of a.resources) items.append(el('li', {}, el('a', { href: r.url }, r.title)));
        for (const [k, href] of Object.entries(a.links))
          items.append(el('li', {}, el('a', { href }, t.askLinks[k] ?? k)));
        out.replaceChildren(el('p', {}, a.answer), items);
      })
      .catch(() => out.replaceChildren(el('p', {}, t.askFailed)));
  });
  return form;
}

function render(): void {
  const t = strings(lang);
  document.documentElement.lang = lang;
  document.title = `${t.title} · ${data?.tenant.name ?? config.countyName ?? ''}`.trim();
  const skip = document.querySelector('.skip');
  if (skip) skip.textContent = t.skip;
  app.replaceChildren();
  const county = data?.tenant.name ?? config.countyName ?? '';
  const phone = data?.accessibility.supportPhone ?? config.helpPhone ?? null;

  // Header with the language switch (EQ-06): a link so it works without scripting once loaded.
  const otherLang: Lang = lang === 'en' ? 'es' : 'en';
  const header = el(
    'header',
    {},
    el('p', { class: 'county' }, county),
    el('h1', {}, t.title),
    el(
      'nav',
      { 'aria-label': t.language },
      el(
        'a',
        { href: pageUrl({ lang: otherLang }), lang: otherLang, hreflang: otherLang },
        otherLang === 'es' ? 'Español' : 'English',
      ),
    ),
  );
  app.append(header);
  app.append(el('p', { class: 'danger', role: 'note' }, t.danger));
  app.append(el('p', { class: 'intro' }, t.intro));

  const main = el('main', { id: 'main', tabindex: '-1' });
  app.append(main);

  // Search (PUB-07): ZIP, address or landmark; nothing typed is kept.
  const form = el('form', {
    class: 'search',
    role: 'search',
    method: 'get',
    action: location.pathname,
  });
  const input = el('input', {
    type: 'search',
    name: 'near',
    id: 'near',
    value: near,
    autocomplete: 'postal-code',
    inputmode: 'text',
    'aria-describedby': 'near-hint',
  });
  form.append(
    el('label', { for: 'near' }, t.searchLabel),
    input,
    el('p', { id: 'near-hint', class: 'hint' }, t.searchHint),
  );
  const kindSelect = el(
    'select',
    { name: 'kind', id: 'kind' },
    el('option', { value: '' }, t.kindAll),
  );
  for (const k of Object.keys(t.kind)) {
    const o = el('option', { value: k }, t.kind[k]!);
    if (k === kind) o.setAttribute('selected', 'selected');
    kindSelect.append(o);
  }
  form.append(el('label', { for: 'kind' }, t.kindLabel), kindSelect);
  form.append(el('input', { type: 'hidden', name: 'lang', value: lang }));
  const locate = el('button', { type: 'button', class: 'secondary' }, t.useLocation);
  form.append(el('div', { class: 'actions' }, el('button', { type: 'submit' }, t.search), locate));
  const status = el('p', { role: 'status', class: 'status-line', 'aria-live': 'polite' });
  form.append(status);
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    near = input.value.trim();
    kind = kindSelect.value;
    history.replaceState(null, '', pageUrl({ near, kind }));
    void refresh(status);
  });
  locate.addEventListener('click', () => {
    if (!('geolocation' in navigator)) return;
    status.textContent = t.locating;
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        near = `${pos.coords.latitude.toFixed(4)},${pos.coords.longitude.toFixed(4)}`;
        input.value = near;
        history.replaceState(null, '', pageUrl({ near }));
        void refresh(status);
      },
      () => {
        status.textContent = t.locationDenied;
      },
      { timeout: 10_000, maximumAge: 60_000 },
    );
  });
  main.append(form);
  if (pathTenant ?? config.tenant) main.append(askForm(pathTenant ?? config.tenant!, t));
  main.append(
    el('p', { class: 'offer-link' }, el('a', { href: pageUrl({ view: 'offer' }) }, t.offerLink)),
  );

  if (!data) {
    main.append(el('p', { role: 'status' }, t.loading));
    return;
  }
  if (data.near) {
    main.append(
      el(
        'p',
        { class: 'near' },
        data.near.resolved
          ? t.nearLabel(data.near.label ?? data.near.query)
          : t.nearUnknown(data.near.query),
      ),
    );
  }

  const sitesHeading = el('h2', { id: 'sites' }, t.sites);
  main.append(sitesHeading);
  const list = el('div', { class: 'sites', role: 'list' });
  if (data.sites.length === 0) list.append(el('p', {}, t.noSites));
  for (const s of data.sites) {
    const card = siteCard(s, t);
    card.setAttribute('role', 'listitem');
    list.append(card);
  }
  main.append(list);

  // Optional map (PUB-07, SCL-13): the library loads only when asked for.
  const mapToggle = el(
    'button',
    {
      type: 'button',
      class: 'secondary',
      'aria-expanded': String(mapOpen),
      'aria-controls': 'map',
    },
    mapOpen ? t.hideMap : t.showMap,
  );
  const mapBox = el('div', { id: 'map', class: 'map', hidden: '' });
  const mapNote = el('p', { class: 'hint' }, t.mapNote);
  mapToggle.addEventListener('click', () => {
    mapOpen = !mapOpen;
    mapToggle.setAttribute('aria-expanded', String(mapOpen));
    mapToggle.textContent = mapOpen ? t.hideMap : t.showMap;
    if (mapOpen) {
      mapBox.removeAttribute('hidden');
      mapBox.textContent = t.mapLoading;
      import('./map.ts')
        .then((m) => m.showMap(mapBox, data?.sites ?? [], lang))
        .catch(() => {
          mapBox.textContent = t.mapFailed;
        });
    } else mapBox.setAttribute('hidden', '');
  });
  if (data.sites.some((s) => s.position))
    main.append(el('div', { class: 'map-tools' }, mapToggle, mapNote), mapBox);

  if (data.resources.length > 0) {
    main.append(el('h2', { id: 'resources' }, t.resources));
    const ul = el('ul', { class: 'resources' });
    for (const r of data.resources) {
      const li = el('li', {}, el('a', { href: r.url }, r.title));
      if (r.summary) li.append(el('p', {}, r.summary));
      ul.append(li);
    }
    main.append(ul);
  }

  const tools = el(
    'div',
    { class: 'tools' },
    el('button', { type: 'button', class: 'secondary', 'data-print': 'list' }, t.print),
    el('button', { type: 'button', class: 'secondary', 'data-print': 'poster' }, t.printPoster),
  );
  tools.querySelectorAll('button').forEach((b) =>
    b.addEventListener('click', () => {
      document.body.dataset['print'] = b.dataset['print'] ?? 'list';
      if (b.dataset['print'] === 'poster') void renderPoster(t, phone);
      else window.print();
    }),
  );
  main.append(tools);

  const footer = el(
    'footer',
    {},
    el('h2', {}, t.a11yTitle),
    el('p', {}, data.accessibility.statement),
    el('p', {}, t.a11yContact),
    phone
      ? el(
          'p',
          {},
          el('strong', {}, `${t.helpLine}: `),
          el('a', { href: `tel:${phone.replace(/[^\d+]/g, '')}` }, phone),
        )
      : null,
    el('p', {}, t.textKeyword),
    el('p', { class: 'muted' }, t.notEligibility),
    el('p', { class: 'muted' }, `${t.updated}: ${shortTime(data.generatedAt)}`),
  );
  app.append(footer);
}

/** PUB-15: a one-tap poster: large type, phone number, short web address and a QR code (never the QR alone, ACC-50). */
async function renderPoster(t: Strings, phone: string | null): Promise<void> {
  const existing = document.getElementById('poster');
  existing?.remove();
  const short = `${location.origin}${location.pathname}`;
  const poster = el(
    'section',
    { id: 'poster', class: 'poster', 'aria-label': t.printPoster },
    el('p', { class: 'county' }, data?.tenant.name ?? ''),
    el('h1', {}, t.posterTitle),
    el('p', { class: 'big' }, t.posterText),
    phone ? el('p', { class: 'big phone' }, phone) : null,
    el('p', { class: 'big url' }, short),
  );
  try {
    const { toString } = await import('qrcode');
    const svg = await toString(short, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
    const holder = el('div', { class: 'qr', role: 'img', 'aria-label': t.posterQr });
    holder.innerHTML = svg; // generated by the library from our own URL, no user text
    poster.append(holder);
  } catch {
    /* no QR: the address and phone are on the poster (ACC-50) */
  }
  poster.append(el('p', {}, t.posterQr));
  document.body.append(poster);
  window.print();
}

async function refresh(status?: HTMLElement): Promise<void> {
  const t = strings(lang);
  const tenant = pathTenant ?? config.tenant ?? null;
  if (!tenant) {
    app.replaceChildren(el('p', { role: 'alert' }, t.loadFailed));
    return;
  }
  if (pathTenant === null) {
    location.replace(`/${encodeURIComponent(tenant)}/help${location.search}`);
    return;
  }
  try {
    data = await load(tenant);
    render();
    if (status) status.textContent = '';
    document.getElementById('sites')?.focus?.();
  } catch {
    const last = lastLoaded();
    if (last) {
      data = last;
      render();
      app.prepend(
        el('p', { role: 'alert', class: 'danger' }, navigator.onLine ? t.loadFailed : t.offline),
      );
    } else {
      render();
      document
        .querySelector('main')
        ?.append(el('p', { role: 'alert', class: 'danger' }, t.loadFailed));
    }
  }
}

window.addEventListener('afterprint', () => {
  delete document.body.dataset['print'];
  document.getElementById('poster')?.remove();
});

/** REC-01: the "offer a place" view, on the same page and the same language switch. */
function renderOffer(tenant: string): void {
  const t = strings(lang);
  document.documentElement.lang = lang;
  // REC-01: an owner's re-check link opens the same form, filled in.
  const update = url.searchParams.get('update');
  const title = update ? t.offer.updateTitle : t.offer.title;
  document.title = `${title} · ${config.countyName ?? ''}`.trim();
  const otherLang: Lang = lang === 'en' ? 'es' : 'en';
  const main = el('main', { id: 'main', tabindex: '-1' });
  main.append(
    el('p', { class: 'danger', role: 'note' }, t.danger),
    el('p', { class: 'intro' }, update ? t.offer.updateIntro : t.offer.intro),
    offerForm(el, tenant, lang, t, pageUrl({ view: null, update: null }), update),
  );
  app.replaceChildren(
    el(
      'header',
      {},
      el('p', { class: 'county' }, config.countyName ?? ''),
      el('h1', {}, title),
      el(
        'nav',
        { 'aria-label': t.language },
        el(
          'a',
          { href: pageUrl({ lang: otherLang }), lang: otherLang, hreflang: otherLang },
          otherLang === 'es' ? 'Español' : 'English',
        ),
      ),
    ),
    main,
  );
}

config = await loadConfig();
if (url.searchParams.get('view') === 'offer' && (pathTenant ?? config.tenant)) {
  renderOffer(pathTenant ?? config.tenant!);
} else {
  render();
  await refresh();
}
