/**
 * The public command coverage (layer-7 task C; CMD-19, AC-C03, Section 30.2,
 * ACC-31, AC-A08): a resident may ask about published help, start or resume
 * their own report, and see their own report only after proving it is
 * theirs. Nothing else. The question is read with fixed rules in English and
 * Spanish, no model and no staff data: the answer is a pointer to the form,
 * the resume page or the verified status page, or the published sites and
 * resources that match the words. The ask box sits beside the form and never
 * replaces it.
 */
import type { PublicResource, PublicSite } from './sites-view.ts';

export type AskIntent = 'status' | 'resume' | 'report' | 'find';

const fold = (s: string) => s.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '');

const STATUS =
  /\b(status|estado|my report|mi (reporte|informe)|what happened|que paso|reference|codigo de referencia|was (it|my report) approved|aprobad)/;
const RESUME = /\b(resume|continue|finish|keep going|draft|continuar|terminar|seguir|borrador)\b/;
const REPORT = /\b(report|damage|damaged|reportar|reporte|dano|danos|start|empezar|comenzar)\b/;

/** Plain words that point at a kind of site, in both languages. */
const KINDS: [RegExp, string][] = [
  [/\b(shelter|refugio|albergue|sleep|dormir)\b/, 'shelter'],
  [/\b(food|comida|meals?|comidas|alimentos|feeding|eat|comer)\b/, 'feeding'],
  [/\b(water|agua|supplies|suministros|pod)\b/, 'pod'],
  [/\b(cooling|cool|heat|calor|enfriamiento)\b/, 'cooling'],
  [/\b(warming|warm|cold|frio|calentamiento)\b/, 'warming'],
  [/\b(charge|charging|cargar|phone charging)\b/, 'charging'],
  [/\b(recovery center|centro de recuperacion|marc)\b/, 'marc'],
];

const STOP = new Set(
  'the a an and or of for to in on at is are i we my our me need needs want where how can do does near help with from by this that it there show find list tell give get any que la el los las de del en un una y o mi mis necesito necesitamos donde como hay para por con ayuda cerca muestrame mostrar buscar dame'.split(
    ' ',
  ),
);

export function askIntent(text: string): AskIntent {
  const t = fold(text);
  if (STATUS.test(t)) return 'status';
  if (RESUME.test(t)) return 'resume';
  if (REPORT.test(t) && !KINDS.some(([re]) => re.test(t))) return 'report';
  return 'find';
}

/** Published sites and resources whose words match the question; nearest first as given. */
export function matchHelp(
  text: string,
  sites: PublicSite[],
  resources: PublicResource[],
): { sites: PublicSite[]; resources: PublicResource[] } {
  const t = fold(text);
  const kinds = KINDS.filter(([re]) => re.test(t)).map(([, k]) => k);
  const words = t.split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 3 && !STOP.has(w));
  // Whole words, or the start of a longer one (shelter → shelters), never the middle of a word.
  const hits = (hay: string) => {
    const tokens = fold(hay).split(/[^\p{L}\p{N}]+/u);
    return words.some((w) => tokens.some((t) => t === w || (w.length >= 4 && t.startsWith(w))));
  };
  const s = sites.filter(
    (x) =>
      x.status !== 'closed' &&
      (kinds.includes(x.kind) || hits(`${x.name} ${x.kind} ${x.services.join(' ')}`)),
  );
  const r = resources.filter((x) => hits(`${x.title} ${x.summary ?? ''} ${x.category} ${x.type}`));
  return { sites: s.slice(0, 5), resources: r.slice(0, 5) };
}
