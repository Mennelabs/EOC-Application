/**
 * Job aids are written as plain text and stored as a small, fixed set of HTML
 * (FL-15, BRD:FR-18.03): a line starting "## " is a heading, lines starting
 * "- " are a list, and other lines, separated by a blank line, are
 * paragraphs. Everything is escaped, so nothing typed becomes markup. The
 * field app reads the result as text again (apps/field/src/format.ts).
 */

const escape = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function jobAidHtml(text: string): string {
  const out: string[] = [];
  let list: string[] = [];
  let para: string[] = [];
  const flushList = () => {
    if (list.length) out.push(`<ul>${list.map((i) => `<li>${escape(i)}</li>`).join('')}</ul>`);
    list = [];
  };
  const flushPara = () => {
    if (para.length) out.push(`<p>${escape(para.join(' '))}</p>`);
    para = [];
  };
  for (const raw of text.replace(/\r\n?/g, '\n').split('\n')) {
    const line = raw.trim();
    if (line === '') {
      flushList();
      flushPara();
    } else if (line.startsWith('## ')) {
      flushList();
      flushPara();
      out.push(`<h2>${escape(line.slice(3).trim())}</h2>`);
    } else if (line.startsWith('- ')) {
      flushPara();
      list.push(line.slice(2).trim());
    } else {
      flushList();
      para.push(line);
    }
  }
  flushList();
  flushPara();
  return out.join('');
}

const unescape = (s: string) =>
  s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');

/** The stored HTML back as the plain text it is edited in (headings, lists, paragraphs). */
export function jobAidText(html: string): string {
  const blocks: string[] = [];
  const re = /<(h[1-6]|p|ul|ol)\b[^>]*>([\s\S]*?)<\/\1>/gi;
  for (const m of html.matchAll(re)) {
    const tag = m[1]!.toLowerCase();
    const inner = m[2]!;
    const strip = (s: string) => unescape(s.replace(/<[^>]+>/g, '')).trim();
    if (tag === 'ul' || tag === 'ol')
      blocks.push(
        [...inner.matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/gi)]
          .map((li) => `- ${strip(li[1]!)}`)
          .join('\n'),
      );
    else if (tag.startsWith('h')) blocks.push(`## ${strip(inner)}`);
    else blocks.push(strip(inner));
  }
  return blocks.join('\n\n');
}
