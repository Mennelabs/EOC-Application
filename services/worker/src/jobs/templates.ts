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
  | 'publication_notice'
  | 'help_alert'
  | 'field_message'
  | 'reminder_overdue'
  | 'ai_quality_notice'
  | 'facility_recheck'
  | 'facility_recheck_owner'
  | 'discovery_digest'
  | 'discovery_alert'
  | 'health_notice'
  | 'health_notice_ended';

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
  'help_alert',
  'field_message',
  'reminder_overdue',
  'ai_quality_notice',
  'facility_recheck',
  'facility_recheck_owner',
  'discovery_digest',
  'discovery_alert',
  // FL:FR-06: a health notice for the resident's area, and its end.
  'health_notice',
  'health_notice_ended',
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
  /** FL:FR-06: the area a health notice covers, in words. */
  area?: string;
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
    help_alert: (v: TemplateVars) =>
      `${v.county} Emergency Mgmt: field safety alert (${v.kind ?? 'alert'}) for ${v.site ?? 'a team'} raised ${v.dueAt ?? 'just now'}; nobody has acknowledged it. Open the dispatch board.`,
    field_message: (v: TemplateVars) =>
      `${v.county} dispatch: ${v.text ?? ''} (Reply through the app when you can; in danger now, call 911.)`,
    reminder_overdue: (v: TemplateVars) =>
      `${v.county} Emergency Mgmt: the reminder "${v.title ?? ''}" was due ${v.dueAt ?? 'earlier'} and nobody has acknowledged it. Open the console.`,
    ai_quality_notice: (v: TemplateVars) =>
      `${v.county} Emergency Mgmt: the AI feature "${v.title ?? ''}" needs a look: ${v.what ?? ''} It keeps running. Open the AI use register.`,
    facility_recheck: (v: TemplateVars) =>
      `${v.county} Emergency Mgmt: please check that the details of ${v.site ?? 'your facility'} in the facility registry are still right by ${v.dueAt ?? 'its re-check date'}.`,
    facility_recheck_owner: (v: TemplateVars) =>
      `${v.county} Emergency Mgmt: please check the details of ${v.site ?? 'your facility'} by ${v.dueAt ?? 'its re-check date'}: ${v.url ?? ''}`,
    discovery_digest: (v: TemplateVars) =>
      `${v.county} Emergency Mgmt: resource discovery found ${v.count ?? 'some'} place(s) for the registry. Review them in the console's discovery queue.`,
    discovery_alert: (v: TemplateVars) =>
      `${v.county} Emergency Mgmt: a possible resource near unmet need: ${v.site ?? 'a place'} (${v.kind ?? 'place'}). Review it in the discovery queue; nothing is added until someone decides.`,
    health_notice: (v: TemplateVars) =>
      `${v.county} health notice for your area: ${v.title ?? 'see the details'}. ${v.url ? `Details: ${v.url} ` : ''}Reply STOP to opt out.`,
    health_notice_ended: (v: TemplateVars) =>
      `${v.county}: the health notice for your area has ended (${v.title ?? 'see the details'}). ${v.url ? `Details: ${v.url} ` : ''}Reply STOP to opt out.`,
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
    help_alert: (v: TemplateVars) => ({
      subject: `${v.county}: field safety alert for ${v.site ?? 'a team'} needs acknowledgement`,
      body:
        `A ${v.kind ?? 'safety'} alert for ${v.site ?? 'a team'} was raised at ${v.dueAt ?? 'an unknown time'} and nobody on ${v.county}'s dispatch board has acknowledged it.\n\n` +
        `${v.what ? `${v.what}\n\n` : ''}` +
        `Open the dispatch board to acknowledge it and reach the team: ${v.url ?? ''}\n\n` +
        `If anyone is in danger now, call 911.\n`,
    }),
    field_message: (v: TemplateVars) => ({
      subject: `${v.county} dispatch: a message for you`,
      body: `${v.text ?? ''}\n\nSent by ${v.sender ?? v.county} dispatch. Reply through the app when you can. If you are in danger now, call 911.\n`,
    }),
    reminder_overdue: (v: TemplateVars) => ({
      subject: `${v.county}: an overdue reminder needs acknowledgement`,
      body:
        `The reminder "${v.title ?? ''}" was due ${v.dueAt ?? 'earlier'} and nobody on ${v.county}'s console has acknowledged it.\n\n` +
        `${v.what ? `${v.what}\n\n` : ''}Open the console to acknowledge, snooze or complete it: ${v.url ?? ''}\n`,
    }),
    discovery_digest: (v: TemplateVars) => ({
      subject: `${v.county}: ${v.count ?? 'some'} place(s) found by resource discovery`,
      body:
        `Resource discovery found these places for ${v.county}'s facility registry:\n\n${v.items ?? ''}\n\n` +
        `Review each one in the console's discovery queue, with its source links and what is still unknown, and qualify it in or out with a reason. ` +
        `Nothing is added to, changed in or removed from the registry until someone decides. A place set aside is not proposed again unless something about it changes.\n`,
    }),
    discovery_alert: (v: TemplateVars) => ({
      subject: `${v.county}: a possible resource near unmet need: ${v.site ?? 'a place'}`,
      body:
        `${v.site ?? 'A place'} (${v.kind ?? 'place'}) was found by ${v.county}'s resource discovery (${v.what ?? 'a source'}). It is within 3 km of open requests for food or a place to stay in the active event.\n\n` +
        `It is not in the facility registry. Review it now in the console's discovery queue and qualify it in or out. Nothing is added until someone decides.\n`,
    }),
    health_notice: (v: TemplateVars) => ({
      subject: `${v.county}: ${v.title ?? 'a health notice for your area'}`,
      body:
        `${v.county} public health issued this notice for ${v.area ?? 'your area'}:\n\n${v.title ?? ''}\n\n${v.text ?? ''}\n\n` +
        (v.url ? `It is also on the county's help page: ${v.url}\n\n` : '') +
        `You get this because you reported damage or asked for help at an address in this area. This message does not send emergency help. If you are in danger now, call 911.\n`,
    }),
    health_notice_ended: (v: TemplateVars) => ({
      subject: `${v.county}: notice ended: ${v.title ?? 'health notice for your area'}`,
      body:
        `${v.county} public health has ended the notice "${v.title ?? ''}" for ${v.area ?? 'your area'}${v.what ? ` (${v.what})` : ''}.\n\n` +
        (v.url ? `See the county's help page for anything still in force: ${v.url}\n\n` : '') +
        `This message does not send emergency help. If you are in danger now, call 911.\n`,
    }),
    facility_recheck_owner: (v: TemplateVars) => ({
      subject: `${v.county}: please re-check ${v.site ?? 'your facility'} in the facility registry`,
      body:
        `${v.site ?? 'Your facility'} is in ${v.county}'s facility registry, which the county uses to plan shelters, supply points and recovery centers.\n\n` +
        `Each entry is re-checked once a year. By ${v.dueAt ?? 'its re-check date'}, please open this link, look over the details (space, access, power, kitchen, showers, parking) and either say nothing has changed or correct what has:\n\n${v.url ?? ''}\n\n` +
        `The link works once and expires. What you send goes to the county for review before the registry changes. If you did not expect this email, you can ignore it.\n`,
    }),
    facility_recheck: (v: TemplateVars) => ({
      subject: `${v.county}: please re-check ${v.site ?? 'a facility'} in the facility registry`,
      body:
        `${v.site ?? 'A facility'} is in ${v.county}'s facility registry, which the county uses to plan shelters, supply points and recovery centers.\n\n` +
        `Each entry is re-checked once a year. Please confirm by ${v.dueAt ?? 'its re-check date'} that its details (space, access, power, kitchen, showers, pets, parking, agreement and contacts) are still right, or tell the county what changed. ` +
        `An entry that is not re-checked is marked stale and planners are warned before they rely on it.\n`,
    }),
    ai_quality_notice: (v: TemplateVars) => ({
      subject: `${v.county}: the AI feature "${v.title ?? ''}" needs a look`,
      body:
        `${v.county}: ${v.what ?? ''}\n\n` +
        `The feature keeps running; people still decide everything it suggests. Look at recent outputs in the AI use register, and change the model or prompt, or switch the feature off, if it is not helping.\n`,
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
    help_alert: (v) =>
      `Gestión de Emergencias de ${v.county}: alerta de seguridad en campo (${v.kind ?? 'alerta'}) para ${v.site ?? 'un equipo'} emitida ${v.dueAt ?? 'ahora'}; nadie la ha atendido. Abra el tablero de despacho.`,
    field_message: (v) =>
      `Despacho de ${v.county}: ${v.text ?? ''} (Responda por la aplicación cuando pueda; si está en peligro ahora, llame al 911.)`,
    reminder_overdue: (v) =>
      `Gestión de Emergencias de ${v.county}: el recordatorio "${v.title ?? ''}" venció ${v.dueAt ?? 'antes'} y nadie lo ha atendido. Abra la consola.`,
    ai_quality_notice: (v) =>
      `Gestión de Emergencias de ${v.county}: la función de IA "${v.title ?? ''}" necesita revisión: ${v.what ?? ''} Sigue funcionando. Abra el registro de uso de IA.`,
    facility_recheck: (v) =>
      `Manejo de Emergencias de ${v.county}: revise que los datos de ${v.site ?? 'su instalación'} en el registro de instalaciones sigan correctos antes de ${v.dueAt ?? 'su fecha de revisión'}.`,
    facility_recheck_owner: (v) =>
      `Manejo de Emergencias de ${v.county}: revise los datos de ${v.site ?? 'su instalación'} antes de ${v.dueAt ?? 'su fecha de revisión'}: ${v.url ?? ''}`,
    discovery_digest: (v) =>
      `Manejo de Emergencias de ${v.county}: la búsqueda de recursos encontró ${v.count ?? 'algunos'} lugar(es) para el registro. Revíselos en la cola de búsqueda de la consola.`,
    discovery_alert: (v) =>
      `Manejo de Emergencias de ${v.county}: un posible recurso cerca de necesidades sin atender: ${v.site ?? 'un lugar'} (${v.kind ?? 'lugar'}). Revíselo en la cola de búsqueda; nada se agrega hasta que alguien decida.`,
    health_notice: (v) =>
      `${v.county}, aviso de salud para su zona: ${v.title ?? 'vea los detalles'}. ${v.url ? `Detalles: ${v.url} ` : ''}Responda ALTO para no recibir mensajes.`,
    health_notice_ended: (v) =>
      `${v.county}: terminó el aviso de salud para su zona (${v.title ?? 'vea los detalles'}). ${v.url ? `Detalles: ${v.url} ` : ''}Responda ALTO para no recibir mensajes.`,
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
    help_alert: (v) => ({
      subject: `${v.county}: una alerta de seguridad en campo para ${v.site ?? 'un equipo'} necesita atención`,
      body:
        `Se emitió una alerta (${v.kind ?? 'seguridad'}) para ${v.site ?? 'un equipo'} a las ${v.dueAt ?? 'hora desconocida'} y nadie en el tablero de despacho de ${v.county} la ha atendido.\n\n` +
        `${v.what ? `${v.what}\n\n` : ''}` +
        `Abra el tablero de despacho para atenderla y comunicarse con el equipo: ${v.url ?? ''}\n\n` +
        `Si alguien está en peligro ahora, llame al 911.\n`,
    }),
    field_message: (v) => ({
      subject: `Despacho de ${v.county}: un mensaje para usted`,
      body: `${v.text ?? ''}\n\nEnviado por el despacho de ${v.sender ?? v.county}. Responda por la aplicación cuando pueda. Si está en peligro ahora, llame al 911.\n`,
    }),
    reminder_overdue: (v) => ({
      subject: `${v.county}: un recordatorio vencido necesita atención`,
      body:
        `El recordatorio "${v.title ?? ''}" venció ${v.dueAt ?? 'antes'} y nadie en la consola de ${v.county} lo ha atendido.\n\n` +
        `${v.what ? `${v.what}\n\n` : ''}Abra la consola para atenderlo, posponerlo o completarlo: ${v.url ?? ''}\n`,
    }),
    discovery_digest: (v) => ({
      subject: `${v.county}: ${v.count ?? 'algunos'} lugar(es) encontrados por la búsqueda de recursos`,
      body:
        `La búsqueda de recursos encontró estos lugares para el registro de instalaciones de ${v.county}:\n\n${v.items ?? ''}\n\n` +
        `Revise cada uno en la cola de búsqueda de la consola, con sus enlaces de origen y lo que aún se desconoce, y acéptelo o descártelo con un motivo. ` +
        `Nada se agrega, cambia o quita del registro hasta que alguien decida. Un lugar descartado no se vuelve a proponer salvo que algo cambie.\n`,
    }),
    discovery_alert: (v) => ({
      subject: `${v.county}: un posible recurso cerca de necesidades sin atender: ${v.site ?? 'un lugar'}`,
      body:
        `${v.site ?? 'Un lugar'} (${v.kind ?? 'lugar'}) fue encontrado por la búsqueda de recursos de ${v.county} (${v.what ?? 'una fuente'}). Está a menos de 3 km de solicitudes abiertas de comida o de un lugar donde quedarse en el evento activo.\n\n` +
        `No está en el registro de instalaciones. Revíselo ahora en la cola de búsqueda de la consola y acéptelo o descártelo. Nada se agrega hasta que alguien decida.\n`,
    }),
    health_notice: (v) => ({
      subject: `${v.county}: ${v.title ?? 'un aviso de salud para su zona'}`,
      body:
        `Salud pública de ${v.county} emitió este aviso para ${v.area ?? 'su zona'}:\n\n${v.title ?? ''}\n\n${v.text ?? ''}\n\n` +
        (v.url ? `También está en la página de ayuda del condado: ${v.url}\n\n` : '') +
        `Recibe esto porque reportó daños o pidió ayuda en una dirección de esta zona. Este mensaje no envía ayuda de emergencia. Si está en peligro ahora, llame al 911.\n`,
    }),
    health_notice_ended: (v) => ({
      subject: `${v.county}: terminó el aviso: ${v.title ?? 'aviso de salud para su zona'}`,
      body:
        `Salud pública de ${v.county} terminó el aviso "${v.title ?? ''}" para ${v.area ?? 'su zona'}${v.what ? ` (${v.what})` : ''}.\n\n` +
        (v.url ? `Vea en la página de ayuda del condado lo que sigue vigente: ${v.url}\n\n` : '') +
        `Este mensaje no envía ayuda de emergencia. Si está en peligro ahora, llame al 911.\n`,
    }),
    facility_recheck_owner: (v) => ({
      subject: `${v.county}: revise ${v.site ?? 'su instalación'} en el registro de instalaciones`,
      body:
        `${v.site ?? 'Su instalación'} está en el registro de instalaciones de ${v.county}, que el condado usa para planear refugios, puntos de distribución y centros de recuperación.\n\n` +
        `Cada registro se revisa una vez al año. Antes de ${v.dueAt ?? 'su fecha de revisión'}, abra este enlace, revise los datos (espacio, acceso, energía, cocina, duchas, estacionamiento) y diga que nada cambió o corrija lo que cambió:\n\n${v.url ?? ''}\n\n` +
        `El enlace funciona una sola vez y vence. Lo que envíe lo revisa el condado antes de cambiar el registro. Si no esperaba este correo, puede ignorarlo.\n`,
    }),
    facility_recheck: (v) => ({
      subject: `${v.county}: revise ${v.site ?? 'una instalación'} en el registro de instalaciones`,
      body:
        `${v.site ?? 'Una instalación'} está en el registro de instalaciones de ${v.county}, que el condado usa para planear refugios, puntos de distribución y centros de recuperación.\n\n` +
        `Cada registro se revisa una vez al año. Confirme antes de ${v.dueAt ?? 'su fecha de revisión'} que sus datos (espacio, acceso, energía, cocina, duchas, mascotas, estacionamiento, acuerdo y contactos) siguen correctos, o diga al condado qué cambió. ` +
        `Un registro sin revisar se marca como desactualizado y se avisa a quien planea antes de usarlo.\n`,
    }),
    ai_quality_notice: (v) => ({
      subject: `${v.county}: la función de IA "${v.title ?? ''}" necesita revisión`,
      body:
        `${v.county}: ${v.what ?? ''}\n\n` +
        `La función sigue funcionando; las personas siguen decidiendo todo lo que sugiere. Revise los resultados recientes en el registro de uso de IA y cambie el modelo o la instrucción, o apague la función, si no está ayudando.\n`,
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
