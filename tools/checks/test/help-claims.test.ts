/**
 * AC-18C, BRD:FR-18.03: product help describes what the platform does, never
 * features that are not built (live tracking, printing straight to a printer,
 * and the rest of docs/operations/known-limitations.md). Scans the text people
 * read in the apps, the API's command help, job aids, question graphs and seed
 * content, with code comments removed. A rule with `limitation` must name a
 * line of the known-limitations page: when a feature is built, its line there
 * and its rule here go together.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));

interface Rule {
  name: string;
  /** What is not built, with its requirement IDs. */
  about: string;
  patterns: RegExp[];
  /** Only files under this path (from the repository root). */
  only?: string;
  /** Text of the known-limitations line this rule keeps true. */
  limitation?: string;
  /** A claim the rule must catch, and honest text from the apps it must let through. */
  claim: string;
  honest: string[];
}

const RULES: Rule[] = [
  {
    name: 'live tracking',
    about:
      'Nobody is shown where a team is on its way; dispatch sees last reported positions with their age (AC-18C, BRD:FR-03.05)',
    patterns: [
      /\b(?:live|real[- ]?time)\s+(?:gps\s+|location\s+)?tracking\b/i,
      /\btrack\s+(?:your|their|the)\s+(?:team|crew|responders?|volunteers?|truck|help|request|inspector)\b/i,
      /\bsee\s+where\s+(?:your|the)\s+(?:team|crew|help|inspector|volunteers?)\s+(?:is|are)\b/i,
      /\b(?:rastreo|seguimiento)\s+en\s+(?:tiempo\s+real|vivo)\b/i,
    ],
    claim: 'Track your team live on the map.',
    honest: ['Live translation', 'If the number is right, a text is on its way.'],
  },
  {
    name: 'printing straight to a printer',
    about:
      'Badges, passes and codes print from the browser; printer integration is later work (AC-18C, BRD:FR-13.05, FL-01, FL:FR-14)',
    patterns: [
      /\bprint(?:s|ed)?\s+automatically\b/i,
      /\bautomatic(?:ally)?\s+print/i,
      /\bBrother\s+(?:printer|label|QL|PT|TD)/,
      /\bsent\s+(?:straight\s+)?to\s+the\s+(?:badge\s+|label\s+|wristband\s+)?printer\b/i,
      /\bprinted\s+wristbands?\b/i,
      /\bwristbands?\s+(?:is|are|will\s+be|gets?)\s+printed\b/i,
      /\bprint\s+(?:the|a|your)\s+wristband/i,
      /\b(?:impresi[oó]n|se\s+imprime)\s+autom[aá]tica(?:mente)?\b/i,
    ],
    limitation: 'Printing straight to badge and wristband printers',
    claim: 'The badge is sent to the printer and prints automatically.',
    honest: [
      'Badge generated. Print it now: the code is shown only this once.',
      "Record that you saw Ana's badge come out of the printer.",
      'Write it on the wristband. It is shown only once.',
    ],
  },
  {
    name: 'the field app on iPhone',
    about: 'The field app is built and tested for Android and the web build only',
    patterns: [/\b(?:iPhone|iPad|App Store|TestFlight)\b/],
    only: 'apps/field/',
    limitation: 'The field app on iPhone',
    claim: 'Install the app from the App Store.',
    honest: ['Android'],
  },
  {
    name: 'smartwatch',
    about: 'No watch support (FL-08)',
    patterns: [
      /\b(?:smart\s?watch(?:es)?|Apple\s+Watch|Wear\s+OS)\b/i,
      /\breloj(?:es)?\s+inteligentes?\b/i,
    ],
    limitation: 'smartwatch support (FL-08)',
    claim: 'Press the help button on your smartwatch.',
    honest: ['Watch for downed lines.'],
  },
  {
    name: 'lock-screen widget',
    about: 'No lock-screen widget for the help button (FL-06)',
    patterns: [
      /\block[- ]screen\s+widgets?\b/i,
      /\bwidget\b[^.]{0,30}\bpantalla\s+de\s+bloqueo\b/i,
    ],
    claim: 'Use the lock-screen widget to call for help.',
    honest: ['The app locks after five minutes.'],
  },
  {
    name: 'antivirus scanning',
    about:
      'Uploads are decoded and saved again as new images; nothing scans them for viruses (BRD:INT-03)',
    patterns: [
      /\banti-?virus\b/i,
      /\bvirus[- ]scan(?:ned|ning)?\b/i,
      /\bscanned\s+for\s+(?:viruses|malware)\b/i,
      /\bmalware\s+scan/i,
    ],
    limitation: 'there is no antivirus scan',
    claim: 'Every photo is scanned for viruses.',
    honest: ['Scan the badge code at the door.'],
  },
  {
    name: 'pre-disaster imagery',
    about: 'No imagery source is approved (FLD-06, BRD:FR-03.06)',
    patterns: [
      /\b(?:pre-disaster|before-and-after|satellite|aerial)\s+(?:imagery|images|photos)\b/i,
    ],
    limitation: 'Pre-disaster imagery (FLD-06)',
    claim: 'Compare with pre-disaster imagery of the parcel.',
    honest: ['Take a photo of the damage.'],
  },
  {
    name: 'criminal-justice feeds',
    about:
      'No CAD, NCIC or records-management feed without a separately approved contract (BRD:INT-07)',
    patterns: [/\b(?:NCIC|CAD|RMS)\s+(?:feeds?|quer(?:y|ies)|lookups?|integrations?|imports?)\b/],
    limitation: 'CAD, NCIC and records-management feeds (BRD:INT-07)',
    claim: 'Run an NCIC query on the person.',
    honest: ['Add a note for the CJIS-qualified team.'],
  },
  {
    name: 'releasing assignments at going off duty',
    about: 'No release policy is applied when a person goes off duty (AC-05C, BRD:DEC-07 open)',
    patterns: [
      /\b(?:assignments?|missions?)\s+(?:are|is)\s+(?:automatically\s+)?released\s+(?:automatically\s+)?when\b[^.]{0,40}\boff[- ]duty\b/i,
    ],
    limitation: 'when they go off duty (AC-05C)',
    claim: 'Your missions are released automatically when you go off duty.',
    honest: ['Check out when your shift ends.'],
  },
  {
    name: 'an interpreter joining inside the platform',
    about: 'The interpreter calls in by phone or video outside the platform (FL:FR-24)',
    patterns: [
      /\binterpreters?\s+(?:can\s+)?joins?\s+(?:the|this|your)\s+(?:conversation|call|session)\s+(?:in|through|from)\s+(?:the\s+)?app\b/i,
    ],
    limitation: 'An interpreter joining a conversation from inside the platform',
    claim: 'An interpreter can join the conversation from the app.',
    honest: ['An interpreter joins by phone or video, or comes in person.'],
  },
  {
    name: 'case management',
    about:
      'No appointments or SBA queue on the shared record; case management comes after layer 8 (FL-13, FL:FR-07, 12, 18, 27)',
    patterns: [
      /\b(?:book|schedule)\s+(?:an?\s+|your\s+)?appointments?\s+(?:here|in\s+the\s+app|through\s+(?:this|the)\s+(?:app|site|page))\b/i,
      /\bSBA\s+queue\b/i,
    ],
    limitation: 'Case management on the shared record',
    claim: 'Book an appointment here with the SBA queue.',
    honest: ['Walk-in or by appointment.'],
  },
  {
    name: 'sending closures to Waze',
    about: 'Waze reads the county feed once the county enrols; nothing is sent to Waze (FL:FR-05)',
    patterns: [
      /\b(?:sends?|pushe[sd]|posts?|sent)\s+(?:the\s+)?(?:road\s+)?(?:closures?|reports?)\s+to\s+Waze\b/i,
    ],
    claim: 'We send road closures to Waze.',
    honest: ['Waze reads the county’s road closures from this address.'],
  },
  {
    name: 'unit-by-unit status',
    about: 'A property manager reports each place, not each unit (FL:FR-31)',
    patterns: [/\bunit[- ]by[- ]unit\b/i],
    limitation: 'Unit-by-unit status for a property manager (FL:FR-31)',
    claim: 'Update unit-by-unit status for your building.',
    honest: ['Report another place for the same organization.'],
  },
];

/** Where the text people read lives: apps, services, packages and the seed. */
const SOURCES = [
  'apps/web-resident/src',
  'apps/web-help/src',
  'apps/web-console/src',
  'apps/web-cjis/src',
  'apps/field/src',
  'apps/field/app',
  'services/api/src',
  'services/cjis-api/src',
  'services/worker/src',
  ...readdirSync(join(ROOT, 'packages')).map((p) => `packages/${p}/src`),
  'tools/seed/src',
];

function walk(dir: string): string[] {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.flatMap((e) => {
    const path = join(dir, e.name);
    if (e.isDirectory())
      return ['node_modules', 'dist', 'test', '__tests__'].includes(e.name) ? [] : walk(path);
    return /\.(?:ts|tsx|html)$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) ? [path] : [];
  });
}

/** Removes comments, keeping line numbers: notes to developers are not help. */
function withoutComments(text: string): string {
  const blank = (m: string) => m.replace(/[^\n]/g, ' ');
  return text
    .replace(/(^|[\s{(])\/\*[\s\S]*?\*\//g, (m, lead: string) => lead + blank(m.slice(lead.length)))
    .replace(/(^|\s)\/\/.*$/gm, (m, lead: string) => lead + blank(m.slice(lead.length)))
    .replace(/<!--[\s\S]*?-->/g, blank);
}

const files = SOURCES.flatMap((s) => walk(join(ROOT, s))).map((f) => relative(ROOT, f));

describe('AC-18C: product help describes only what is built', () => {
  it('reads the places help text lives', () => {
    for (const f of [
      'apps/web-resident/src/i18n/messages.ts',
      'apps/web-help/src/i18n.ts',
      'apps/field/src/i18n.ts',
      'apps/web-console/src/ui/command-window.tsx',
      'services/api/src/commands/catalog.ts',
      'services/api/src/job-aid-text.ts',
      'packages/intake/src/graphs/westwind.ts',
    ])
      expect(files, f).toContain(f);
    expect(files.length).toBeGreaterThan(300);
  });

  it.each(RULES)('$name: catches its claim and lets honest text through', (rule) => {
    expect(rule.patterns.some((p) => p.test(rule.claim))).toBe(true);
    for (const text of rule.honest)
      expect(
        rule.patterns.filter((p) => p.test(text)),
        text,
      ).toEqual([]);
  });

  it('every rule tied to a known limitation names a line of that page', () => {
    const page = readFileSync(join(ROOT, 'docs/operations/known-limitations.md'), 'utf8');
    for (const rule of RULES)
      if (rule.limitation) expect(page, rule.name).toContain(rule.limitation);
  });

  it('no help, job aid, question or seed text claims a feature that is not built', () => {
    const found: string[] = [];
    for (const file of files) {
      const lines = withoutComments(readFileSync(join(ROOT, file), 'utf8')).split('\n');
      for (const rule of RULES) {
        if (rule.only && !file.startsWith(rule.only)) continue;
        lines.forEach((line, i) => {
          for (const p of rule.patterns) {
            const m = p.exec(line);
            if (m) found.push(`${file}:${i + 1}: ${rule.name} (${rule.about}): "${m[0]}"`);
          }
        });
      }
    }
    expect(found).toEqual([]);
  });
});
