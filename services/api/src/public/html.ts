/**
 * Server-rendered public pages (PUB-13, PUB-18, A11Y-01, ACC-49/51): one
 * document shell with a skip link, a main landmark, large readable type and
 * no scripts, and an allow-list sanitiser for staff-authored resource HTML
 * so nothing but plain content and links reaches a resident's browser.
 */

export function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const ALLOWED_TAGS = new Set([
  'p',
  'br',
  'a',
  'ul',
  'ol',
  'li',
  'strong',
  'em',
  'b',
  'i',
  'h2',
  'h3',
  'h4',
  'blockquote',
]);

/** Keeps only safe links: web, phone and mail. */
export function safeHref(href: string): string | null {
  const trimmed = href.trim();
  if (/^(https?:\/\/|tel:|mailto:)/i.test(trimmed)) return trimmed;
  return null;
}

/**
 * Allow-list sanitiser: known tags survive without attributes (links keep a
 * safe href and open as plain links), everything else is dropped as a tag but
 * its text stays; script and style contents are removed entirely.
 */
export function sanitizeHtml(input: string): string {
  const withoutBlocks = input.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '');
  return withoutBlocks.replace(
    /<\/?([a-zA-Z][a-zA-Z0-9]*)\b([^>]*)>/g,
    (_m, rawTag: string, attrs: string) => {
      const tag = rawTag.toLowerCase();
      if (!ALLOWED_TAGS.has(tag)) return '';
      const closing = _m.startsWith('</');
      if (closing) return `</${tag}>`;
      if (tag === 'br') return '<br>';
      if (tag === 'a') {
        const m = /href\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(attrs);
        const href = m ? safeHref(m[2] ?? m[3] ?? m[4] ?? '') : null;
        return href ? `<a href="${escapeHtml(href)}" rel="noopener">` : '<a>';
      }
      return `<${tag}>`;
    },
  );
}

/** Accessibility checks a resource must pass before it is published (PUB-18, ACC-49/51). */
export function checkResourceHtml(html: string): string[] {
  const problems: string[] = [];
  const links = [...html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)];
  for (const [, attrs, inner] of links) {
    const text = (inner ?? '').replace(/<[^>]+>/g, '').trim();
    if (!text) problems.push('a link has no text');
    else if (/^(click here|here|link|more|read more)$/i.test(text))
      problems.push(`link text "${text}" does not say where it goes`);
    const href = /href\s*=\s*("([^"]*)"|'([^']*)')/i.exec(attrs ?? '');
    const target = (href?.[2] ?? href?.[3] ?? '').toLowerCase();
    if (target.endsWith('.pdf') && !/\b(html|web page|text version)\b/i.test(html))
      problems.push('a PDF is the only way to the guidance; add the content or an HTML page');
  }
  if (/<h1\b/i.test(html))
    problems.push('use headings from level 2 down; the page supplies the title');
  const levels = [...html.matchAll(/<h([2-4])\b/gi)].map((m) => Number(m[1]));
  for (let i = 1; i < levels.length; i++)
    if (levels[i]! > levels[i - 1]! + 1)
      problems.push('heading levels skip (for example h2 to h4)');
  if (/<img\b(?![^>]*\balt=)/i.test(html)) problems.push('an image has no alt text');
  return problems;
}

export interface PageOptions {
  lang: string;
  title: string;
  /** Already-safe HTML for <main>. */
  body: string;
  tenantName: string;
  /** Seconds between automatic refreshes (media sheet); none when absent. */
  refreshSeconds?: number;
  footer?: string;
}

const STRINGS = {
  en: {
    skip: 'Skip to content',
    notEligibility: 'This page never decides who is eligible for help. It lists where help is.',
  },
  es: {
    skip: 'Saltar al contenido',
    notEligibility: 'Esta página nunca decide quién recibe ayuda. Muestra dónde está la ayuda.',
  },
};

export function page(o: PageOptions): string {
  const t = o.lang.startsWith('es') ? STRINGS.es : STRINGS.en;
  return `<!doctype html>
<html lang="${escapeHtml(o.lang)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
${o.refreshSeconds ? `<meta http-equiv="refresh" content="${o.refreshSeconds}">` : ''}
<title>${escapeHtml(o.title)} · ${escapeHtml(o.tenantName)}</title>
<style>
:root{color-scheme:light dark;font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;font-size:1.125rem;line-height:1.5}
body{margin:0;padding:0 1rem 2rem;max-width:48rem;margin-inline:auto}
.skip{position:absolute;left:-999px;top:0}.skip:focus{left:1rem;background:#fff;color:#000;padding:.5rem}
h1,h2,h3{line-height:1.25}a{text-underline-offset:.15em}
table{border-collapse:collapse;width:100%}th,td{text-align:left;vertical-align:top;padding:.4rem .5rem;border-bottom:1px solid #8884}
.muted{opacity:.8}.status{font-weight:600}
@media print{.skip,nav{display:none}body{font-size:14pt}}
</style>
</head>
<body>
<a class="skip" href="#main">${t.skip}</a>
<header><p class="muted">${escapeHtml(o.tenantName)}</p><h1>${escapeHtml(o.title)}</h1></header>
<main id="main">
${o.body}
</main>
<footer><p class="muted">${t.notEligibility}</p>${o.footer ?? ''}</footer>
</body>
</html>
`;
}
