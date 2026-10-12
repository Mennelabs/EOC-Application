/**
 * Resident strings (EQ-06/07). English and Spanish at launch; every string is
 * translatable. Spanish strings here are drafts for professional translation
 * and community review before release (EQ-07), tracked in the layer-2 plan.
 * Tone rules: calm, no exclamation marks, no blame (INT-17, INT-18).
 */
export const locales = ['en', 'es'] as const;
export type Locale = (typeof locales)[number];

/** Each language named in its own script (EQ-10). */
export const localeNames: Record<Locale, string> = { en: 'English', es: 'Español' };

export const messages = {
  en: {
    'page.title': 'Report storm damage — {county}',
    'header.agency': '{county} Emergency Management',
    'language.label': 'Language',
    'safety.heading': 'In danger right now?',
    'safety.body': 'Call 911. This form does not send help.',
    'intro.heading': 'Tell us how the storm affected your home',
    'intro.body': 'We will ask one question at a time. You can say “I don’t know” or skip.',
    'facts.time': 'About 5 minutes',
    'facts.noAccount': 'No account or ID needed',
    'facts.everyone': 'Renters and owners can both report',
    'start.button': 'Start',
    'start.notYet': 'Online reporting opens soon. Please call or text {phone} to report now.',
    'footer.noDecision': 'Reporting does not decide whether you get help.',
    'footer.talk': 'Prefer to talk? Call or text {phone}.',
    'footer.poweredBy': 'Runs on {product}',
    'county.fallback': 'Your county',
    'phone.fallback': 'your county help line',
  },
  es: {
    'page.title': 'Reportar daños por la tormenta — {county}',
    'header.agency': 'Manejo de Emergencias de {county}',
    'language.label': 'Idioma',
    'safety.heading': '¿Está en peligro ahora mismo?',
    'safety.body': 'Llame al 911. Este formulario no envía ayuda.',
    'intro.heading': 'Cuéntenos cómo afectó la tormenta a su hogar',
    'intro.body': 'Le haremos una pregunta a la vez. Puede decir “No sé” o saltarla.',
    'facts.time': 'Unos 5 minutos',
    'facts.noAccount': 'No necesita cuenta ni identificación',
    'facts.everyone': 'Pueden reportar inquilinos y propietarios',
    'start.button': 'Comenzar',
    'start.notYet':
      'El reporte en línea abrirá pronto. Llame o envíe un mensaje al {phone} para reportar ahora.',
    'footer.noDecision': 'Reportar no decide si usted recibe ayuda.',
    'footer.talk': '¿Prefiere hablar? Llame o envíe un mensaje al {phone}.',
    'footer.poweredBy': 'Funciona con {product}',
    'county.fallback': 'Su condado',
    'phone.fallback': 'la línea de ayuda de su condado',
  },
} satisfies Record<Locale, Record<string, string>>;

export type MessageId = keyof (typeof messages)['en'];

/** Device language first, English otherwise (EQ-10). */
export function detectLocale(languages: readonly string[]): Locale {
  for (const tag of languages) {
    const base = tag.toLowerCase().split('-')[0];
    if ((locales as readonly string[]).includes(base ?? '')) return base as Locale;
  }
  return 'en';
}
