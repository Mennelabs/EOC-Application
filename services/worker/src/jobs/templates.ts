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
  | 'needs_confirmation'
  | 'staff_update'
  | 'referral_notice'
  | 'site_reconfirm'
  | 'site_hidden'
  | 'resource_attention'
  | 'contact_reverify'
  | 'publication_notice';

export const TEMPLATE_NAMES: readonly TemplateName[] = [
  'confirmation',
  'opt_in_confirmation',
  'otp',
  'correction_request',
  'withdrawn',
  'sharing_recall',
  'needs_confirmation',
  'staff_update',
  'referral_notice',
  'site_reconfirm',
  'site_hidden',
  'resource_attention',
  'contact_reverify',
  'publication_notice',
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
  /** A staff update to the resident (FL-11): the plain text and who sent it. */
  text?: string;
  sender?: string;
  /** A referral notice to a partner organization (FL-10). */
  purpose?: string;
  /** Staff reminders and notices (F09, PUB-03, BRD:FR-16.03, CNT-01, PUB-06). */
  site?: string;
  dueAt?: string;
  title?: string;
  what?: string;
  items?: string;
  count?: string;
  kind?: string;
  version?: string;
  approver?: string;
  channels?: string;
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
    staff_update: (v: TemplateVars) =>
      `${v.county} Emergency Mgmt (${v.sender ?? v.county}) about report ${v.referenceCode}: ${v.text ?? ''} Reply to this text to answer. In danger now? Call 911. Reply STOP to opt out.`,
    referral_notice: (v: TemplateVars) =>
      `${v.county} Emergency Mgmt: a referral for record ${v.referenceCode} was sent to ${v.partner ?? 'your organization'}: ${v.purpose ?? ''}. Open your workspace to accept it.`,
    site_reconfirm: (v: TemplateVars) =>
      `${v.county} Emergency Mgmt: please confirm ${v.site ?? 'your site'} is still as published by ${v.dueAt ?? 'the end of its window'}, or it leaves the public page.`,
    site_hidden: (v: TemplateVars) =>
      `${v.county} Emergency Mgmt: ${v.site ?? 'your site'} was not confirmed by ${v.dueAt ?? 'its deadline'} and is hidden from the public page until confirmed.`,
    resource_attention: (v: TemplateVars) =>
      `${v.county} Emergency Mgmt: the public resource "${v.title ?? ''}" ${v.what ?? 'needs attention'}.`,
    contact_reverify: (v: TemplateVars) =>
      `${v.county} Emergency Mgmt: ${v.count ?? 'some'} interagency contact(s) are due for re-verification. See the contacts registry.`,
    publication_notice: (v: TemplateVars) =>
      `${v.county} Emergency Mgmt: ${v.kind ?? 'item'} "${v.title ?? ''}" ${v.what ?? 'published'} (v${v.version ?? '?'}) by ${v.approver ?? 'a named approver'}.`,
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
    staff_update: (v: TemplateVars) => ({
      subject: `${v.county}: an update about your report ${v.referenceCode}`,
      body:
        `${v.sender ?? v.county} sent you an update about report ${v.referenceCode}:\n\n${v.text ?? ''}\n\n` +
        `Reply to this email to answer. This message does not send emergency help. If you are in danger now, call 911.\n` +
        (v.helpPhone ? `Questions? Call ${v.helpPhone}.\n` : ''),
    }),
    referral_notice: (v: TemplateVars) => ({
      subject: `${v.county}: a referral for record ${v.referenceCode}`,
      body:
        `${v.county} Emergency Management sent ${v.partner ?? 'your organization'} a referral for record ${v.referenceCode}.\n\n` +
        `Purpose: ${v.purpose ?? ''}\n\n` +
        `Open your partner workspace to accept or decline it. Only the sections the resident agreed to share are visible, and the referral rides on that consent.\n`,
    }),
    site_reconfirm: (v: TemplateVars) => ({
      subject: `${v.county}: confirm ${v.site ?? 'your site'} by ${v.dueAt ?? 'its deadline'}`,
      body:
        `${v.site ?? 'Your site'} is published on ${v.county}'s public help page, texts and phone line.\n\n` +
        `Please confirm in the console that it is still as published (status, hours, services) by ${v.dueAt ?? 'the end of its confirmation window'}. ` +
        `A site that is not confirmed in time is hidden on every channel until someone confirms it (PUB-03).\n`,
    }),
    site_hidden: (v: TemplateVars) => ({
      subject: `${v.county}: ${v.site ?? 'a site'} is hidden until confirmed`,
      body:
        `${v.site ?? 'A site'} was not confirmed by ${v.dueAt ?? 'its deadline'}, so it is no longer shown on ${v.county}'s public help page, in texts or on the phone line.\n\n` +
        `Confirm it in the console to show it again, or close it if it is no longer open.\n`,
    }),
    resource_attention: (v: TemplateVars) => ({
      subject: `${v.county}: public resource "${v.title ?? ''}" needs attention`,
      body:
        `${v.county} Emergency Management: the public resource "${v.title ?? ''}" ${v.what ?? 'needs attention'}.\n\n` +
        `Open it in the console under Resources to review, correct, extend or remove it. Nothing expired is shown as current (AC-16B).\n`,
    }),
    contact_reverify: (v: TemplateVars) => ({
      subject: `${v.county}: ${v.count ?? 'some'} interagency contact(s) due for re-verification`,
      body:
        `${v.county} Emergency Management: these interagency contacts reach their re-verification date within two weeks or are past it:\n\n${v.items ?? ''}\n\n` +
        `Call each one, then mark it verified in the console under Contacts (names and numbers are shown there, not in this email).\n`,
    }),
    publication_notice: (v: TemplateVars) => ({
      subject: `${v.county}: ${v.kind ?? 'item'} "${v.title ?? ''}" ${v.what ?? 'published'}`,
      body:
        `${v.county} Emergency Management: ${v.kind ?? 'item'} "${v.title ?? ''}" (version ${v.version ?? '?'}) was ${v.what ?? 'published'} by ${v.approver ?? 'a named approver'}.\n\n` +
        `Reason: ${v.why ?? ''}\nChannels: ${v.channels ?? ''}\n\n` +
        `The public page, texts, the phone line, the feeds and the widget already carry the change. Pass it on to social media, 211 and the press as your plan says, and record what you sent in the publication log.\n`,
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
    staff_update: (v) =>
      `${v.county} (${v.sender ?? v.county}) sobre el reporte ${v.referenceCode}: ${v.text ?? ''} Responda a este texto. ¿En peligro? Llame al 911. Responda ALTO para cancelar.`,
    referral_notice: (v) =>
      `${v.county}: se envió una referencia del registro ${v.referenceCode} a ${v.partner ?? 'su organización'}: ${v.purpose ?? ''}. Abra su espacio de trabajo para aceptarla.`,
    site_reconfirm: (v) =>
      `Manejo de Emergencias de ${v.county}: confirme que ${v.site ?? 'su sitio'} sigue como se publicó antes de ${v.dueAt ?? 'que termine su plazo'}, o dejará de verse en la página pública.`,
    site_hidden: (v) =>
      `Manejo de Emergencias de ${v.county}: ${v.site ?? 'su sitio'} no se confirmó antes de ${v.dueAt ?? 'su plazo'} y está oculto de la página pública hasta que se confirme.`,
    resource_attention: (v) =>
      `Manejo de Emergencias de ${v.county}: el recurso público "${v.title ?? ''}" ${v.what ?? 'necesita atención'}.`,
    contact_reverify: (v) =>
      `Manejo de Emergencias de ${v.county}: ${v.count ?? 'algunos'} contacto(s) interinstitucionales deben reverificarse. Vea el registro de contactos.`,
    publication_notice: (v) =>
      `Manejo de Emergencias de ${v.county}: ${v.kind ?? 'elemento'} "${v.title ?? ''}" ${v.what ?? 'publicado'} (v${v.version ?? '?'}) por ${v.approver ?? 'una persona autorizada'}.`,
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
    staff_update: (v) => ({
      subject: `${v.county}: una novedad sobre su reporte ${v.referenceCode}`,
      body:
        `${v.sender ?? v.county} le envió una novedad sobre el reporte ${v.referenceCode}:\n\n${v.text ?? ''}\n\n` +
        `Responda a este correo para contestar. Este mensaje no envía ayuda de emergencia. Si está en peligro ahora, llame al 911.\n` +
        (v.helpPhone ? `¿Preguntas? Llame al ${v.helpPhone}.\n` : ''),
    }),
    referral_notice: (v) => ({
      subject: `${v.county}: una referencia del registro ${v.referenceCode}`,
      body:
        `Manejo de Emergencias de ${v.county} envió a ${v.partner ?? 'su organización'} una referencia del registro ${v.referenceCode}.\n\n` +
        `Propósito: ${v.purpose ?? ''}\n\n` +
        `Abra su espacio de trabajo para aceptarla o rechazarla. Solo se ven las secciones que el residente aceptó compartir.\n`,
    }),
    site_reconfirm: (v) => ({
      subject: `${v.county}: confirme ${v.site ?? 'su sitio'} antes de ${v.dueAt ?? 'su plazo'}`,
      body:
        `${v.site ?? 'Su sitio'} está publicado en la página pública de ayuda, los mensajes de texto y la línea telefónica de ${v.county}.\n\n` +
        `Confirme en la consola que sigue como se publicó (estado, horario, servicios) antes de ${v.dueAt ?? 'que termine su plazo de confirmación'}. ` +
        `Un sitio que no se confirma a tiempo se oculta en todos los canales hasta que alguien lo confirme (PUB-03).\n`,
    }),
    site_hidden: (v) => ({
      subject: `${v.county}: ${v.site ?? 'un sitio'} está oculto hasta que se confirme`,
      body:
        `${v.site ?? 'Un sitio'} no se confirmó antes de ${v.dueAt ?? 'su plazo'}, así que ya no se muestra en la página pública de ayuda, en los mensajes de texto ni en la línea telefónica de ${v.county}.\n\n` +
        `Confírmelo en la consola para mostrarlo de nuevo, o ciérrelo si ya no está abierto.\n`,
    }),
    resource_attention: (v) => ({
      subject: `${v.county}: el recurso público "${v.title ?? ''}" necesita atención`,
      body:
        `Manejo de Emergencias de ${v.county}: el recurso público "${v.title ?? ''}" ${v.what ?? 'necesita atención'}.\n\n` +
        `Ábralo en la consola, en Recursos, para revisarlo, corregirlo, extenderlo o retirarlo. Nada vencido se muestra como vigente (AC-16B).\n`,
    }),
    contact_reverify: (v) => ({
      subject: `${v.county}: ${v.count ?? 'algunos'} contacto(s) interinstitucionales por reverificar`,
      body:
        `Manejo de Emergencias de ${v.county}: estos contactos interinstitucionales llegan a su fecha de reverificación en dos semanas o ya la pasaron:\n\n${v.items ?? ''}\n\n` +
        `Llame a cada uno y márquelo como verificado en la consola, en Contactos (los nombres y números se muestran allí, no en este correo).\n`,
    }),
    publication_notice: (v) => ({
      subject: `${v.county}: ${v.kind ?? 'elemento'} "${v.title ?? ''}" ${v.what ?? 'publicado'}`,
      body:
        `Manejo de Emergencias de ${v.county}: ${v.kind ?? 'elemento'} "${v.title ?? ''}" (versión ${v.version ?? '?'}) fue ${v.what ?? 'publicado'} por ${v.approver ?? 'una persona autorizada'}.\n\n` +
        `Motivo: ${v.why ?? ''}\nCanales: ${v.channels ?? ''}\n\n` +
        `La página pública, los mensajes de texto, la línea telefónica, los feeds y el widget ya llevan el cambio. Páselo a redes sociales, al 211 y a la prensa según su plan, y anote lo enviado en el registro de publicaciones.\n`,
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
