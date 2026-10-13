/**
 * Messages to residents (docs/06 templates, CHN-03, RULE-17, ADM-03). The
 * county's name comes from the tenant record, never the product name; nothing
 * here reads like an emergency alert (carriers reject that wording); the
 * resident is always told that a report does not send help (CON-10). Spanish
 * texts are drafts pending professional translation (EQ-07).
 */
export type TemplateName =
  | 'confirmation'
  | 'opt_in_confirmation'
  | 'otp'
  | 'correction_request'
  | 'withdrawn'
  | 'sharing_recall'
  | 'needs_confirmation';

export const TEMPLATE_NAMES: readonly TemplateName[] = [
  'confirmation',
  'opt_in_confirmation',
  'otp',
  'correction_request',
  'withdrawn',
  'sharing_recall',
  'needs_confirmation',
];

export interface TemplateVars {
  /** The county or organisation as the resident knows it (tenant name). */
  county: string;
  helpPhone?: string | null;
  referenceCode?: string;
  code?: string;
  /** Where the resident opens their report (lookup with code + contact). */
  url?: string;
  /** A reviewer's plain-language note, when they wrote one. */
  note?: string;
  /** Recall notice to a partner organization (NED-05): who, what sections, since when, why. */
  partner?: string;
  sections?: string;
  sharedSince?: string;
  why?: string;
}

export interface Rendered {
  body: string;
  /** Email only. */
  subject?: string;
}

const EN = {
  sms: {
    confirmation: (v: TemplateVars) =>
      `${v.county} Emergency Mgmt: Thanks for reporting damage. Your reference number is ${v.referenceCode}. This does not send emergency help. In danger now? Call 911. Reply STOP to opt out.`,
    opt_in_confirmation: (v: TemplateVars) =>
      `${v.county} Emergency Mgmt: You're signed up for messages about your disaster report. Msg frequency varies. Msg & data rates may apply. Reply HELP for help, STOP to opt out.`,
    otp: (v: TemplateVars) =>
      `${v.county} Emergency Mgmt: Your one-time code is ${v.code}. It expires in 10 minutes. If you did not ask for it, ignore this text.`,
    correction_request: (v: TemplateVars) =>
      `${v.county} Emergency Mgmt: We have a question about your damage report ${v.referenceCode}. ${v.url ? `Open your report at ${v.url}` : `Call ${v.helpPhone ?? 'the county help line'}`}. Reply STOP to opt out.`,
    withdrawn: (v: TemplateVars) =>
      `${v.county} Emergency Mgmt: Your damage report ${v.referenceCode} was withdrawn as you asked.${v.helpPhone ? ` If this was a mistake, call ${v.helpPhone}.` : ''}`,
    sharing_recall: (v: TemplateVars) =>
      `${v.county} Emergency Mgmt: Record ${v.referenceCode} shared with ${v.partner ?? 'your organization'} is recalled (${v.why ?? 'consent withdrawn'}). Delete what you hold of it, as your agreement requires.`,
    needs_confirmation: (v: TemplateVars) =>
      `${v.county} Emergency Mgmt: Thanks for telling us what you need. Your reference number is ${v.referenceCode}. This does not send emergency help. In danger now? Call 911. Reply STOP to opt out.`,
  },
  email: {
    confirmation: (v: TemplateVars) => ({
      subject: `${v.county}: your damage report ${v.referenceCode}`,
      body:
        `Thanks for reporting damage to ${v.county} Emergency Management.\n\n` +
        `Your reference number is ${v.referenceCode}. Keep it. With it and this email address you can check your report, add answers or withdraw it${v.url ? ` at ${v.url}` : ''}.\n\n` +
        `This report does not send emergency help. If you are in danger now, call 911.\n` +
        (v.helpPhone ? `Questions? Call ${v.helpPhone}.\n` : ''),
    }),
    opt_in_confirmation: (v: TemplateVars) => ({
      subject: `${v.county}: messages about your report`,
      body: `You will get messages about your disaster report from ${v.county} Emergency Management. Reply to any of them to ask a question.\n`,
    }),
    otp: (v: TemplateVars) => ({
      subject: `${v.county}: your one-time code`,
      body: `Your one-time code from ${v.county} Emergency Management is ${v.code}. It expires in 10 minutes.\n\nIf you did not ask for it, ignore this email; nothing was changed.\n`,
    }),
    correction_request: (v: TemplateVars) => ({
      subject: `${v.county}: a question about your damage report ${v.referenceCode}`,
      body:
        `${v.county} Emergency Management has a question about your damage report ${v.referenceCode}.\n\n` +
        (v.note ? `${v.note}\n\n` : '') +
        `Open your report${v.url ? ` at ${v.url}` : ''} with your reference number and this email address to answer.` +
        (v.helpPhone ? ` You can also call ${v.helpPhone}.` : '') +
        '\n',
    }),
    withdrawn: (v: TemplateVars) => ({
      subject: `${v.county}: your damage report ${v.referenceCode} was withdrawn`,
      body:
        `${v.county} Emergency Management: your damage report ${v.referenceCode} was withdrawn as you asked.` +
        (v.helpPhone ? ` If this was a mistake, call ${v.helpPhone}.` : '') +
        '\n',
    }),
    sharing_recall: (v: TemplateVars) => ({
      subject: `${v.county}: shared record ${v.referenceCode} recalled`,
      body:
        `${v.county} Emergency Management recalled the record ${v.referenceCode} that was shared with ${v.partner ?? 'your organization'} because ${v.why ?? 'the resident withdrew consent'}.\n\n` +
        `Sections shared: ${v.sections ?? 'none'}. Shared since: ${v.sharedSince ?? 'unknown'}.\n\n` +
        `The record is no longer visible to your organization. Your data-sharing agreement requires you to delete any copy or export you hold of it and to stop contacting the resident about it.` +
        (v.helpPhone ? ` Questions? Call ${v.helpPhone}.` : '') +
        '\n',
    }),
    needs_confirmation: (v: TemplateVars) => ({
      subject: `${v.county}: your request for help ${v.referenceCode}`,
      body:
        `Thanks for telling ${v.county} Emergency Management what you need.\n\n` +
        `Your reference number is ${v.referenceCode}. Keep it: a partner organization or the county may contact you about it, and you can text NOSHARE with it to stop sharing.\n\n` +
        `This does not send emergency help. If you are in danger now, call 911.\n` +
        (v.helpPhone ? `Questions? Call ${v.helpPhone}.\n` : ''),
    }),
  },
};

const ES: typeof EN = {
  sms: {
    confirmation: (v) =>
      `${v.county} Manejo de Emergencias: Gracias por reportar daños. Su referencia es ${v.referenceCode}. No envía ayuda de emergencia. ¿En peligro ahora? Llame al 911. Responda ALTO para cancelar.`,
    opt_in_confirmation: (v) =>
      `${v.county} Manejo de Emergencias: Recibirá mensajes sobre su reporte. La frecuencia varía. Pueden aplicar tarifas. Responda AYUDA para ayuda, ALTO para cancelar.`,
    otp: (v) =>
      `${v.county} Manejo de Emergencias: Su código de un solo uso es ${v.code}. Vence en 10 minutos. Si no lo pidió, ignore este mensaje.`,
    correction_request: (v) =>
      `${v.county} Manejo de Emergencias: Tenemos una pregunta sobre su reporte ${v.referenceCode}. ${v.url ? `Ábralo en ${v.url}` : `Llame al ${v.helpPhone ?? 'la línea de ayuda del condado'}`}. Responda ALTO para cancelar.`,
    withdrawn: (v) =>
      `${v.county} Manejo de Emergencias: Su reporte ${v.referenceCode} fue retirado como pidió.${v.helpPhone ? ` Si fue un error, llame al ${v.helpPhone}.` : ''}`,
    sharing_recall: (v) =>
      `${v.county} Manejo de Emergencias: El registro ${v.referenceCode} compartido con ${v.partner ?? 'su organización'} fue retirado (${v.why ?? 'consentimiento retirado'}). Borre lo que tenga de él, como exige su acuerdo.`,
    needs_confirmation: (v) =>
      `${v.county} Manejo de Emergencias: Gracias por decirnos qué necesita. Referencia: ${v.referenceCode}. No envía ayuda de emergencia. ¿En peligro? Llame al 911. Responda ALTO para cancelar.`,
  },
  email: {
    confirmation: (v) => ({
      subject: `${v.county}: su reporte de daños ${v.referenceCode}`,
      body:
        `Gracias por reportar daños a Manejo de Emergencias de ${v.county}.\n\n` +
        `Su número de referencia es ${v.referenceCode}. Guárdelo. Con él y este correo puede ver su reporte, añadir respuestas o retirarlo${v.url ? ` en ${v.url}` : ''}.\n\n` +
        `Este reporte no envía ayuda de emergencia. Si está en peligro ahora, llame al 911.\n` +
        (v.helpPhone ? `¿Preguntas? Llame al ${v.helpPhone}.\n` : ''),
    }),
    opt_in_confirmation: (v) => ({
      subject: `${v.county}: mensajes sobre su reporte`,
      body: `Recibirá mensajes sobre su reporte de Manejo de Emergencias de ${v.county}. Responda a cualquiera para hacer una pregunta.\n`,
    }),
    otp: (v) => ({
      subject: `${v.county}: su código de un solo uso`,
      body: `Su código de un solo uso de Manejo de Emergencias de ${v.county} es ${v.code}. Vence en 10 minutos.\n\nSi no lo pidió, ignore este correo; nada cambió.\n`,
    }),
    correction_request: (v) => ({
      subject: `${v.county}: una pregunta sobre su reporte ${v.referenceCode}`,
      body:
        `Manejo de Emergencias de ${v.county} tiene una pregunta sobre su reporte de daños ${v.referenceCode}.\n\n` +
        (v.note ? `${v.note}\n\n` : '') +
        `Abra su reporte${v.url ? ` en ${v.url}` : ''} con su número de referencia y este correo para responder.` +
        (v.helpPhone ? ` También puede llamar al ${v.helpPhone}.` : '') +
        '\n',
    }),
    withdrawn: (v) => ({
      subject: `${v.county}: su reporte ${v.referenceCode} fue retirado`,
      body:
        `Manejo de Emergencias de ${v.county}: su reporte de daños ${v.referenceCode} fue retirado como pidió.` +
        (v.helpPhone ? ` Si fue un error, llame al ${v.helpPhone}.` : '') +
        '\n',
    }),
    sharing_recall: (v) => ({
      subject: `${v.county}: registro compartido ${v.referenceCode} retirado`,
      body:
        `Manejo de Emergencias de ${v.county} retiró el registro ${v.referenceCode} compartido con ${v.partner ?? 'su organización'} porque ${v.why ?? 'el residente retiró su consentimiento'}.\n\n` +
        `Secciones compartidas: ${v.sections ?? 'ninguna'}. Compartido desde: ${v.sharedSince ?? 'desconocido'}.\n\n` +
        `Su organización ya no puede ver el registro. Su acuerdo de intercambio de datos le obliga a borrar cualquier copia o exportación y a no contactar al residente sobre él.` +
        (v.helpPhone ? ` ¿Preguntas? Llame al ${v.helpPhone}.` : '') +
        '\n',
    }),
    needs_confirmation: (v) => ({
      subject: `${v.county}: su solicitud de ayuda ${v.referenceCode}`,
      body:
        `Gracias por decirle a Manejo de Emergencias de ${v.county} qué necesita.\n\n` +
        `Su número de referencia es ${v.referenceCode}. Guárdelo: una organización asociada o el condado puede contactarle, y puede enviar NOSHARE con él para dejar de compartir.\n\n` +
        `Esto no envía ayuda de emergencia. Si está en peligro ahora, llame al 911.\n` +
        (v.helpPhone ? `¿Preguntas? Llame al ${v.helpPhone}.\n` : ''),
    }),
  },
};

export function isTemplateName(name: string): name is TemplateName {
  return (TEMPLATE_NAMES as readonly string[]).includes(name);
}

/** Renders a template in the resident's language (Spanish or English; others fall back to English, EQ-06). */
export function renderTemplate(
  name: TemplateName,
  language: string,
  channel: 'sms' | 'email',
  vars: TemplateVars,
): Rendered {
  const set = language.toLowerCase().startsWith('es') ? ES : EN;
  if (channel === 'sms') return { body: set.sms[name](vars) };
  return set.email[name](vars);
}
