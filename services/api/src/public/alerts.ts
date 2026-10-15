/**
 * Alert drafts from a site change (PUB-11): text sized for Wireless Emergency
 * Alerts (90 and 360 characters) and for the county's mass-notification
 * system, in English and Spanish, from deterministic templates. The county
 * sends them through its own authorised alert tool; nothing here transmits.
 * Wording never reads like a dispatch and never promises help (CON-10).
 */

export type SiteChange = 'opened' | 'reopened' | 'limited' | 'full' | 'closed';

export interface AlertSite {
  name: string;
  kind: string;
  address: string | null;
  hours?: string | null;
  pets?: string | null;
  accessibility?: string | null;
}

export interface AlertInput {
  county: string;
  change: SiteChange;
  site: AlertSite;
  /** The next nearest open site of the same kind, for full and closed (PUB-04). */
  next?: AlertSite | null;
  helpUrl?: string | null;
  helpPhone?: string | null;
}

export interface AlertDraft {
  lang: 'en' | 'es';
  wea90: string;
  wea360: string;
  massNotification: string;
  /** PUB-12: a post for the county's social media, at most 280 characters. */
  social: string;
  /** PUB-14: a loop for a low-power AM Travelers' Information Station. */
  radioLoop: string;
  /** PUB-14: a read-out for ARES/RACES nets serving areas without cell service. */
  netReadout: string;
}

const KIND = {
  en: {
    shelter: 'shelter',
    feeding: 'feeding site',
    pod: 'distribution point',
    marc: 'recovery center',
    cooling: 'cooling center',
    warming: 'warming center',
    reporting: 'damage reporting site',
    charging: 'charging station',
    other: 'help site',
  } as Record<string, string>,
  es: {
    shelter: 'albergue',
    feeding: 'sitio de comida',
    pod: 'punto de distribución',
    marc: 'centro de recuperación',
    cooling: 'centro de enfriamiento',
    warming: 'centro para calentarse',
    reporting: 'sitio para reportar daños',
    charging: 'estación de carga',
    other: 'sitio de ayuda',
  } as Record<string, string>,
};

function cut(text: string, max: number): string {
  if (text.length <= max) return text;
  const slice = text.slice(0, max - 1);
  const stop = Math.max(slice.lastIndexOf('. '), slice.lastIndexOf(', '), slice.lastIndexOf(' '));
  return (stop > max * 0.6 ? slice.slice(0, stop) : slice).trimEnd() + '…';
}

export function draftAlerts(input: AlertInput): AlertDraft[] {
  return (['en', 'es'] as const).map((lang) => {
    const kind = KIND[lang][input.site.kind] ?? KIND[lang]['other']!;
    const where = input.site.address ? `, ${input.site.address}` : '';
    const more =
      lang === 'en'
        ? `${input.helpUrl ? ` More: ${input.helpUrl}` : ''}${input.helpPhone ? ` or call ${input.helpPhone}` : ''}.`
        : `${input.helpUrl ? ` Más: ${input.helpUrl}` : ''}${input.helpPhone ? ` o llame al ${input.helpPhone}` : ''}.`;
    const extras = [input.site.hours, input.site.pets, input.site.accessibility]
      .filter(Boolean)
      .join('. ');
    let short: string;
    let long: string;
    let mass: string;
    if (input.change === 'opened' || input.change === 'reopened' || input.change === 'limited') {
      const state =
        input.change === 'limited'
          ? lang === 'en'
            ? 'has limited space'
            : 'tiene espacio limitado'
          : input.change === 'reopened'
            ? lang === 'en'
              ? 'has reopened'
              : 'reabrió'
            : lang === 'en'
              ? 'is open'
              : 'está abierto';
      short =
        lang === 'en'
          ? `${input.county}: ${kind} ${state} at ${input.site.name}${where}.`
          : `${input.county}: ${kind} ${state} en ${input.site.name}${where}.`;
      long = `${short}${extras ? ` ${extras}.` : ''}${more}`;
      mass =
        lang === 'en'
          ? `${input.county} Emergency Management: the ${kind} at ${input.site.name}${where} ${state}.${extras ? ` ${extras}.` : ''} This message does not send help; if anyone is in danger, call 911.${more}`
          : `Manejo de Emergencias de ${input.county}: el ${kind} en ${input.site.name}${where} ${state}.${extras ? ` ${extras}.` : ''} Este mensaje no envía ayuda; si alguien está en peligro, llame al 911.${more}`;
    } else {
      const state =
        input.change === 'full'
          ? lang === 'en'
            ? 'is full'
            : 'está lleno'
          : lang === 'en'
            ? 'is closed'
            : 'está cerrado';
      const nextText = input.next
        ? lang === 'en'
          ? ` Nearest open ${kind}: ${input.next.name}${input.next.address ? `, ${input.next.address}` : ''}.`
          : ` El ${kind} abierto más cercano: ${input.next.name}${input.next.address ? `, ${input.next.address}` : ''}.`
        : lang === 'en'
          ? ` No other ${kind} is open right now.`
          : ` Ningún otro ${kind} está abierto ahora.`;
      short =
        lang === 'en'
          ? `${input.county}: ${input.site.name} (${kind}) ${state}.${nextText}`
          : `${input.county}: ${input.site.name} (${kind}) ${state}.${nextText}`;
      long = `${short}${more}`;
      mass =
        lang === 'en'
          ? `${input.county} Emergency Management: the ${kind} at ${input.site.name}${where} ${state}.${nextText} This message does not send help; if anyone is in danger, call 911.${more}`
          : `Manejo de Emergencias de ${input.county}: el ${kind} en ${input.site.name}${where} ${state}.${nextText} Este mensaje no envía ayuda; si alguien está en peligro, llame al 911.${more}`;
    }
    // PUB-12, PUB-14: the same facts for social media and spoken channels.
    const prefix =
      lang === 'en'
        ? `${input.county} Emergency Management: `
        : `Manejo de Emergencias de ${input.county}: `;
    const core = mass.startsWith(prefix) ? mass.slice(prefix.length) : mass;
    const radioLoop =
      lang === 'en'
        ? `This is ${input.county} Emergency Management. ${core} Again: ${short} This message repeats.`
        : `Le habla Manejo de Emergencias de ${input.county}. ${core} Repetimos: ${short} Este mensaje se repite.`;
    const netReadout =
      lang === 'en'
        ? `${input.county} Emergency Management traffic, for relay to areas without cell service. ${core} End of traffic.`
        : `Mensaje de Manejo de Emergencias de ${input.county}, para retransmitir a zonas sin servicio celular. ${core} Fin del mensaje.`;
    return {
      lang,
      wea90: cut(short, 90),
      wea360: cut(long, 360),
      massNotification: mass,
      social: cut(long, 280),
      radioLoop,
      netReadout,
    };
  });
}
