/**
 * One PDF of each public and resident kind, from synthetic data, for
 * veraPDF in CI (ADR-0040; PUB-13, FL:FR-32, ACC-49, GATE-03), in both
 * launch languages: `pnpm --filter @cg/api samples <dir>`.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderPdf } from '@cg/pdf';
import { samplePng } from '@cg/pdf/samples';
import { mediaSheetPdf, residentCopyPdf } from './pdf.ts';
import type { Lang } from './render.ts';
import type { PublicSite } from './sites-view.ts';

const site = (over: Partial<PublicSite>): PublicSite => ({
  id: '00000000-0000-4000-8000-000000000010',
  slug: 'westwind-high',
  kind: 'shelter',
  name: 'Westwind High School shelter',
  status: 'open',
  address: { line1: '100 School Rd', unit: null, city: 'Westwind', state: 'MO', postal: '64999' },
  position: { lat: 39.1, lon: -94.5 },
  distanceKm: null,
  hours: { always: true },
  services: ['beds', 'meals'],
  pets: 'service_animals',
  accessibility: {},
  medicalPower: true,
  languages: ['en', 'es'],
  transit: null,
  directions: null,
  lastConfirmedAt: '2026-10-15T12:00:00.000Z',
  updatedAt: '2026-10-15T12:05:00.000Z',
  nextNearest: null,
  ...over,
});

const out = process.argv[2] ?? 'pdf-samples';
mkdirSync(out, { recursive: true });
for (const lang of ['en', 'es'] as Lang[]) {
  const media = await renderPdf(
    mediaSheetPdf({
      lang,
      tenantName: 'Exercise Westwind County',
      tenantSlug: 'westwind',
      sites: [
        site({}),
        site({
          id: '00000000-0000-4000-8000-000000000011',
          slug: 'river-pod',
          kind: 'pod',
          name: 'River Road supplies',
          status: 'full',
          hours: { mon: '08:00-18:00' },
          pets: 'unknown',
          nextNearest: { id: 'x', slug: 'x', name: 'Westwind High School shelter', distanceKm: 3 },
        }),
      ],
      resources: [
        {
          id: '00000000-0000-4000-8000-000000000020',
          slug: 'debris',
          type: 'program',
          category: 'cleanup',
          ordering: 1,
          lang,
          title: lang === 'es' ? 'Recolección de escombros' : 'Debris pickup',
          summary: lang === 'es' ? 'Ponga los escombros en la acera.' : 'Put debris at the curb.',
          referenceUrl: null,
          linkStatus: 'ok',
          expiresAt: null,
          reviewedAt: null,
          updatedAt: '2026-10-15T10:00:00.000Z',
        },
      ],
      helpPhone: '+1 555 0100',
      statement: 'Exercise accessibility statement.',
      generatedAt: '2026-10-15T13:00:00.000Z',
      timeZone: 'America/Chicago',
      publicBase: 'https://help.example.org',
      producer: 'Exercise Westwind County',
    }),
  );
  writeFileSync(join(out, `media-sheet-${lang}.pdf`), media);
  const copy = await renderPdf(
    residentCopyPdf({
      lang,
      tenantName: 'Exercise Westwind County',
      timeZone: 'America/Chicago',
      referenceCode: 'WW-7K3M9Q',
      submittedAt: '2026-10-14T18:20:00.000Z',
      state: 'being_reviewed',
      sections: [
        {
          title: lang === 'es' ? 'Su vivienda' : 'Your home',
          items: [
            [lang === 'es' ? 'Dirección' : 'Address', '12 Exercise Lane, Westwind, MO 64999'],
            [lang === 'es' ? 'Tipo de vivienda' : 'Type of home', lang === 'es' ? 'Casa' : 'House'],
          ].map(([prompt, answer]) => ({ prompt: prompt!, answer: answer! })),
        },
        {
          title: lang === 'es' ? 'Qué pasó' : 'What happened',
          items: [
            {
              prompt:
                lang === 'es' ? '¿Qué tan alta llegó el agua?' : 'How high did the water get?',
              answer: '2 ft',
            },
          ],
        },
      ],
      ownWords:
        lang === 'es'
          ? 'Ejercicio: el agua entró al sótano.\n\nEl techo está bien.'
          : 'Exercise: water came into the basement.\n\nThe roof is fine.',
      photos: [
        {
          image: samplePng(),
          shot: lang === 'es' ? 'Frente' : 'Front',
          sentAt: '2026-10-14T18:25:00.000Z',
        },
      ],
      photosPending: 1,
      generatedAt: '2026-10-15T13:00:00.000Z',
      producer: 'Exercise Westwind County',
    }),
  );
  writeFileSync(join(out, `resident-copy-${lang}.pdf`), copy);
}
process.stdout.write(`wrote public and resident samples to ${out}\n`);
