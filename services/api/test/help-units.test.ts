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
    // Every sentence ends once: the help line is its own sentence.
    expect(drafts[0]!.massNotification).toMatch(/call 911\. Questions: call \(314\) 555-0142\.$/);
    expect(drafts[1]!.massNotification).toMatch(
      /llame al 911\. Preguntas: llame al \(314\) 555-0142\.$/,
    );
    const [bare] = draftAlerts({ county: 'Westwind County', change: 'opened', site });
    for (const t of [bare!.massNotification, bare!.wea360, bare!.radioLoop])
      expect(t).not.toMatch(/\.\.|\. or call/);
    const [linked] = draftAlerts({
      county: 'Westwind County',
      change: 'opened',
      site,
      helpUrl: 'https://westwind.example/help',
      helpPhone: '(314) 555-0142',
    });
    expect(linked!.massNotification).toContain(
      'More: https://westwind.example/help. Or call (314) 555-0142.',
    );
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
    expect(en!.social.length).toBeLessThanOrEqual(280);
  });
  it('the social graphic says the same facts line by line, and its alt text says all of it (PUB-12)', () => {
    const [en, es] = draftAlerts({
      county: 'Westwind County',
      change: 'opened',
      site,
      helpPhone: '(314) 555-0142',
    });
    expect(en!.card).toMatchObject({
      heading: 'Westwind County Emergency Management',
      status: 'Shelter open',
      name: 'Harmon High School gym',
      details: [site.address, site.hours, site.pets, site.accessibility],
    });
    expect(en!.card.footer).toContain('call 911');
    for (const part of [en!.card.status, en!.card.name, ...en!.card.details])
      expect(en!.card.alt).toContain(part);
    expect(en!.card.alt).toContain('Questions: (314) 555-0142');
    expect(en!.card.alt).not.toMatch(/\.\./);
    expect(es!.card.status).toBe('Albergue abierto');
    expect(es!.card.heading).toBe('Manejo de Emergencias de Westwind County');
    const [closed] = draftAlerts({ county: 'Westwind County', change: 'closed', site, next: null });
    expect(closed!.card.status).toBe('Shelter closed');
    expect(closed!.card.details).toEqual(['No other shelter is open right now.']);
  });
  it('social post, radio loop and net read-out from the same facts (PUB-12, PUB-14)', () => {
    const [en, es] = draftAlerts({
      county: 'Westwind County',
      change: 'opened',
      site,
      helpPhone: '(314) 555-0142',
    });
    for (const d of [en!, es!]) {
      expect(d.social.length).toBeLessThanOrEqual(280);
      expect(d.social).toContain('Harmon High School gym');
      for (const spoken of [d.radioLoop, d.netReadout]) {
        expect(spoken).toContain('Harmon High School gym');
        expect(spoken).toContain('400 Schoolhouse Rd');
        expect(spoken).toContain('911');
        expect(spoken.toLowerCase()).not.toContain('emergency alert');
      }
    }
    expect(en!.radioLoop).toMatch(/^This is Westwind County Emergency Management\. /);
    expect(en!.radioLoop).toMatch(/This message repeats\.$/);
    expect(en!.netReadout).toMatch(/End of traffic\.$/);
    expect(es!.radioLoop).toMatch(/Este mensaje se repite\.$/);
    expect(es!.netReadout).toMatch(/Fin del mensaje\.$/);
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
