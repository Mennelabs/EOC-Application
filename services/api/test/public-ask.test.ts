/**
 * The public ask rules (layer-7 task C; CMD-19, AC-C03, Section 30.2): fixed
 * rules in English and Spanish, no model; status is only ever a pointer to
 * the verified check; matching is on whole words or their start.
 */
import { describe, expect, it } from 'vitest';
import { askIntent, matchHelp } from '../src/public/ask.ts';
import type { PublicResource, PublicSite } from '../src/public/sites-view.ts';

const site = (slug: string, kind: string, name: string, services: string[] = []) =>
  ({ slug, kind, name, status: 'open', services }) as unknown as PublicSite;
const resource = (slug: string, title: string) =>
  ({ slug, title, summary: null, category: 'help', type: 'program' }) as unknown as PublicResource;

describe('public ask', () => {
  it('reads what the resident wants, in English and Spanish', () => {
    expect(askIntent('what is the status of my report?')).toBe('status');
    expect(askIntent('¿Cuál es el estado de mi reporte?')).toBe('status');
    expect(askIntent('I want to continue my saved report')).toBe('resume');
    expect(askIntent('quiero reportar daños')).toBe('report');
    expect(askIntent('where can I get food')).toBe('find');
    // Damage words with a kind of help are a search, not the form.
    expect(askIntent('damage to my home, where is a shelter')).toBe('find');
  });

  it('matches kinds and whole words, never the middle of a word', () => {
    const sites = [
      site('gym', 'shelter', 'Harmon gym'),
      site('hall', 'feeding', 'Nueva Esperanza hall', ['showers']),
    ];
    const resources = [resource('legal-help', 'Legal help after a disaster')];
    expect(matchHelp('I need a shelter', sites, resources).sites.map((s) => s.slug)).toEqual([
      'gym',
    ]);
    expect(matchHelp('comida', sites, resources).sites.map((s) => s.slug)).toEqual(['hall']);
    expect(matchHelp('legal', sites, resources).resources.map((r) => r.slug)).toEqual([
      'legal-help',
    ]);
    expect(matchHelp('show me the roster', sites, resources)).toEqual({ sites: [], resources: [] });
  });
});
