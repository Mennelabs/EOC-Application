/**
 * Public page helpers (PUB-11, PUB-18, ACC-49/51): alert drafts fit the WEA
 * sizes and never read like a dispatch; the sanitiser keeps plain content and
 * safe links only; the accessibility check catches the usual link problems.
 */
import { describe, expect, it } from 'vitest';
import { draftAlerts } from '../src/public/alerts.ts';
import { checkResourceHtml, sanitizeHtml } from '../src/public/html.ts';

describe('alert drafts (PUB-11)', () => {
  const site = {
    name: 'Harmon High School gym',
    kind: 'shelter',
    address: '400 Schoolhouse Rd, Harmon City, 63005',
    hours: 'Open 24 hours',
    pets: 'Service animals only',
    accessibility: 'Wheelchair accessible',
  };
  it('opened: 90 and 360 character versions and a mass-notification text, in both languages', () => {
    const drafts = draftAlerts({
      county: 'Westwind County',
      change: 'opened',
      site,
      helpPhone: '(314) 555-0142',
    });
    expect(drafts.map((d) => d.lang)).toEqual(['en', 'es']);
    for (const d of drafts) {
      expect(d.wea90.length).toBeLessThanOrEqual(90);
      expect(d.wea360.length).toBeLessThanOrEqual(360);
      expect(d.massNotification).toContain('911');
      expect(d.massNotification.toLowerCase()).not.toContain('emergency alert');
    }
    expect(drafts[0]!.wea90).toContain('Harmon High School gym');
    expect(drafts[1]!.wea90).toContain('albergue');
  });
  it('full or closed names the next nearest open site of the kind (PUB-04)', () => {
    const next = {
      name: 'Westwind Community Center',
      kind: 'shelter',
      address: '1 Civic Plaza, Westwind',
    };
    const [en] = draftAlerts({ county: 'Westwind County', change: 'full', site, next });
    expect(en!.wea360).toContain('is full');
    expect(en!.wea360).toContain('Westwind Community Center');
    const [none] = draftAlerts({ county: 'Westwind County', change: 'closed', site, next: null });
    expect(none!.massNotification).toContain('No other shelter is open');
  });
  it('a very long name still fits the 90 characters', () => {
    const long = { ...site, name: 'A'.repeat(120) };
    const [en] = draftAlerts({ county: 'Westwind County', change: 'opened', site: long });
    expect(en!.wea90.length).toBeLessThanOrEqual(90);
  });
});

describe('resource HTML (PUB-18)', () => {
  it('sanitiser keeps allowed tags and safe links, drops scripts, handlers and unknown tags', () => {
    const dirty =
      '<h2 onclick="x()">Title</h2><script>alert(1)</script><p>Call <a href="javascript:alert(1)">bad</a> or <a href="tel:+13145550142" target="_blank">the line</a>.</p><img src="x" onerror="y()"><div>kept text</div>';
    const clean = sanitizeHtml(dirty);
    expect(clean).toBe(
      '<h2>Title</h2><p>Call <a>bad</a> or <a href="tel:+13145550142" rel="noopener">the line</a>.</p>kept text',
    );
  });
  it('accessibility check: empty or "click here" links, PDF-only guidance, heading jumps, images without alt', () => {
    expect(checkResourceHtml('<p>Call <a href="tel:+1">the help line</a>.</p>')).toEqual([]);
    const problems = checkResourceHtml(
      '<p><a href="https://x.example/guide.pdf">click here</a> <a href="https://x.example"></a></p><h4>Deep</h4><img src="a.png">',
    );
    expect(problems).toEqual(
      expect.arrayContaining([
        'link text "click here" does not say where it goes',
        'a link has no text',
        'a PDF is the only way to the guidance; add the content or an HTML page',
        'an image has no alt text',
      ]),
    );
    expect(checkResourceHtml('<h2>A</h2><h4>B</h4>')).toContain(
      'heading levels skip (for example h2 to h4)',
    );
  });
});
