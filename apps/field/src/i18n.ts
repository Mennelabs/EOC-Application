/**
 * Field app strings (EQ-06/07): English and Spanish at launch. Spanish strings
 * are drafts for professional translation and community review before
 * release (EQ-07). Tone: short, calm, no exclamation marks. The product name
 * never appears here (ADM-03); the county's name comes from configuration.
 */
import { createContext, useContext } from 'react';

export const locales = ['en', 'es'] as const;
export type Locale = (typeof locales)[number];
export const localeNames: Record<Locale, string> = { en: 'English', es: 'Español' };

const en = {
  'app.title': 'Field app',
  'app.subtitle': '{county} volunteer and responder app',
  'emergency.call911': 'If someone is in danger, call 911.',
  'signin.heading': 'Sign in',
  'signin.org.label': 'Organization code',
  'signin.org.hint': 'Your coordinator gives you this code, for example westwind.',
  'signin.button': 'Continue to sign in',
  'signin.working': 'Opening sign-in…',
  'signin.error': 'Sign-in did not work. Check the organization code and try again.',
  'callback.working': 'Finishing sign-in…',
  'unlock.heading': 'Unlock the app',
  'unlock.setHeading': 'Choose a PIN for this phone',
  'unlock.setBody':
    'The PIN protects what the app keeps on this phone. It is not your password, and it never leaves the phone.',
  'unlock.pin': 'PIN (at least 6 digits)',
  'unlock.pinAgain': 'Enter the PIN again',
  'unlock.button': 'Unlock',
  'unlock.setButton': 'Save PIN',
  'unlock.biometric': 'Use fingerprint or face',
  'unlock.wrong': 'That PIN is not right. {left} tries left before the app clears its data.',
  'unlock.mismatch': 'The two PINs are different.',
  'unlock.short': 'Use at least 6 digits.',
  'unlock.wiped': 'Too many wrong PINs. The app cleared its data on this phone. Sign in again.',
  'checkin.heading': 'Check in',
  'checkin.body': 'Enter the event code from staging, or scan the QR code.',
  'checkin.code': 'Event code',
  'checkin.share': 'Share my location with dispatch while I am checked in',
  'checkin.button': 'Check in',
  'checkin.scan': 'Scan QR code',
  'checkin.working': 'Checking in…',
  'checkin.offline': 'Check-in needs a connection. Move to where you have signal and try again.',
  'checkin.error': 'Check-in did not work: {reason}',
  'area.downloading': 'Downloading your area…',
  'area.ready': 'Your area is ready offline.',
  'area.counts': 'Assignments: {assignments} · Properties: {parcels} · Hazards: {hazards}',
  'area.failed': 'The area did not download. It will try again when you have signal.',
  'home.heading': 'My shift',
  'home.team': 'Team: {team}',
  'home.noTeam': 'No team',
  'home.onShift': 'On shift {time}',
  'home.sharing': 'Sharing location with dispatch while checked in',
  'home.notSharing': 'Location sharing is off',
  'home.timer': 'Check-in due {time}',
  'home.ok': 'We’re OK',
  'home.okSent': 'Sent: we’re OK',
  'home.okLead': 'Your team lead confirms the check-in.',
  'home.route': 'Your work',
  'home.noWork': 'No work assigned yet. Dispatch will send it here.',
  'home.acknowledge': 'Got it',
  'home.acknowledged': 'Acknowledged',
  'home.messages': 'Messages from dispatch',
  'home.noMessages': 'No new messages.',
  'home.records': 'Records on this phone: {count}.',
  'home.recordsBody': 'They send when you have signal.',
  'home.allSent': 'Everything on this phone has been received.',
  'home.hazardNear': 'Hazard nearby: {kind}, {distance} m away',
  'home.hazardInside': 'You are inside a hazard area: {kind}',
  'help.button': 'Need help — alert dispatch',
  'help.confirmHeading': 'Send a help alert to dispatch?',
  'help.confirmBody': 'Dispatch gets your exact location and your team.',
  'help.send': 'Send help alert',
  'help.cancel': 'Cancel',
  'help.queued': 'Help alert saved. It sends as soon as there is signal.',
  'help.sent': 'Dispatch has your help alert.',
  'messages.heading': 'Messages',
  'messages.from': 'From dispatch, {time}',
  'messages.ack': 'Got it',
  'messages.acked': 'You confirmed this',
  'sync.heading': 'On this phone',
  'sync.status.on_this_phone': 'On this phone',
  'sync.status.sending': 'Sending',
  'sync.status.received': 'Received',
  'sync.status.conflict': 'Needs a decision',
  'sync.status.rejected': 'Not accepted',
  'sync.lastSync': 'Last sync: {time}',
  'sync.never': 'Not synced yet',
  'sync.offline': 'No connection. Your work is safe on this phone.',
  'sync.now': 'Sync now',
  'sync.empty': 'Nothing waiting.',
  'sync.discard': 'Remove from this phone',
  'sync.conflictBody': 'Someone changed this on the server after you did. Your entry is kept here.',
  'settings.heading': 'Settings',
  'settings.language': 'Language',
  'settings.contrast': 'High contrast for sunlight',
  'settings.large': 'Large buttons for gloves',
  'settings.oneHanded': 'One-handed layout (buttons at the bottom)',
  'settings.battery': 'Battery saver (location less often)',
  'settings.location': 'Share my location with dispatch while checked in',
  'settings.checkout': 'Check out',
  'settings.checkoutBody':
    'Ends your shift. Resident details are cleared from this phone; anything not yet sent stays until it is received.',
  'settings.signout': 'Sign out',
  'settings.policy': 'Location: {reason}',
  'nav.home': 'Home',
  'nav.messages': 'Messages',
  'nav.sync': 'On this phone',
  'nav.settings': 'Settings',
  'wiped.body':
    'Your organization cleared this app’s data from the phone. Sign in again if you still need it.',
  'common.back': 'Back',
  'common.yes': 'Yes',
  'common.no': 'No',
  'common.error': 'Something went wrong: {reason}',
} as const;

export type MessageKey = keyof typeof en;

const es: Record<MessageKey, string> = {
  'app.title': 'App de campo',
  'app.subtitle': 'App para voluntarios y personal de respuesta de {county}',
  'emergency.call911': 'Si alguien está en peligro, llame al 911.',
  'signin.heading': 'Iniciar sesión',
  'signin.org.label': 'Código de la organización',
  'signin.org.hint': 'Su coordinador le da este código, por ejemplo westwind.',
  'signin.button': 'Continuar para iniciar sesión',
  'signin.working': 'Abriendo el inicio de sesión…',
  'signin.error':
    'No se pudo iniciar sesión. Revise el código de la organización e intente de nuevo.',
  'callback.working': 'Terminando el inicio de sesión…',
  'unlock.heading': 'Desbloquear la app',
  'unlock.setHeading': 'Elija un PIN para este teléfono',
  'unlock.setBody':
    'El PIN protege lo que la app guarda en este teléfono. No es su contraseña y nunca sale del teléfono.',
  'unlock.pin': 'PIN (al menos 6 dígitos)',
  'unlock.pinAgain': 'Escriba el PIN otra vez',
  'unlock.button': 'Desbloquear',
  'unlock.setButton': 'Guardar PIN',
  'unlock.biometric': 'Usar huella o rostro',
  'unlock.wrong':
    'Ese PIN no es correcto. Quedan {left} intentos antes de que la app borre sus datos.',
  'unlock.mismatch': 'Los dos PIN son diferentes.',
  'unlock.short': 'Use al menos 6 dígitos.',
  'unlock.wiped':
    'Demasiados PIN incorrectos. La app borró sus datos en este teléfono. Inicie sesión de nuevo.',
  'checkin.heading': 'Registrar llegada',
  'checkin.body':
    'Escriba el código del evento que le dieron en el punto de reunión, o escanee el código QR.',
  'checkin.code': 'Código del evento',
  'checkin.share': 'Compartir mi ubicación con despacho mientras esté registrado',
  'checkin.button': 'Registrar llegada',
  'checkin.scan': 'Escanear código QR',
  'checkin.working': 'Registrando…',
  'checkin.offline':
    'Para registrarse necesita conexión. Vaya a donde tenga señal e intente de nuevo.',
  'checkin.error': 'No se pudo registrar: {reason}',
  'area.downloading': 'Descargando su zona…',
  'area.ready': 'Su zona está lista sin conexión.',
  'area.counts': 'Tareas: {assignments} · Propiedades: {parcels} · Peligros: {hazards}',
  'area.failed': 'La zona no se descargó. Lo intentará de nuevo cuando tenga señal.',
  'home.heading': 'Mi turno',
  'home.team': 'Equipo: {team}',
  'home.noTeam': 'Sin equipo',
  'home.onShift': 'En turno {time}',
  'home.sharing': 'Compartiendo ubicación con despacho mientras está registrado',
  'home.notSharing': 'No está compartiendo su ubicación',
  'home.timer': 'Próximo reporte {time}',
  'home.ok': 'Estamos bien',
  'home.okSent': 'Enviado: estamos bien',
  'home.okLead': 'El líder de su equipo confirma el reporte.',
  'home.route': 'Su trabajo',
  'home.noWork': 'Todavía no tiene trabajo asignado. Despacho lo enviará aquí.',
  'home.acknowledge': 'Entendido',
  'home.acknowledged': 'Confirmado',
  'home.messages': 'Mensajes de despacho',
  'home.noMessages': 'No hay mensajes nuevos.',
  'home.records': 'Registros en este teléfono: {count}.',
  'home.recordsBody': 'Se envían cuando tenga señal.',
  'home.allSent': 'Todo lo de este teléfono ya se recibió.',
  'home.hazardNear': 'Peligro cerca: {kind}, a {distance} m',
  'home.hazardInside': 'Está dentro de una zona de peligro: {kind}',
  'help.button': 'Necesito ayuda — avisar a despacho',
  'help.confirmHeading': '¿Enviar una alerta de ayuda a despacho?',
  'help.confirmBody': 'Despacho recibe su ubicación exacta y su equipo.',
  'help.send': 'Enviar alerta de ayuda',
  'help.cancel': 'Cancelar',
  'help.queued': 'Alerta de ayuda guardada. Se envía en cuanto haya señal.',
  'help.sent': 'Despacho recibió su alerta de ayuda.',
  'messages.heading': 'Mensajes',
  'messages.from': 'De despacho, {time}',
  'messages.ack': 'Entendido',
  'messages.acked': 'Usted lo confirmó',
  'sync.heading': 'En este teléfono',
  'sync.status.on_this_phone': 'En este teléfono',
  'sync.status.sending': 'Enviando',
  'sync.status.received': 'Recibido',
  'sync.status.conflict': 'Necesita una decisión',
  'sync.status.rejected': 'No aceptado',
  'sync.lastSync': 'Última sincronización: {time}',
  'sync.never': 'Todavía no se ha sincronizado',
  'sync.offline': 'Sin conexión. Su trabajo está seguro en este teléfono.',
  'sync.now': 'Sincronizar ahora',
  'sync.empty': 'Nada pendiente.',
  'sync.discard': 'Quitar de este teléfono',
  'sync.conflictBody':
    'Alguien lo cambió en el servidor después que usted. Su registro se guarda aquí.',
  'settings.heading': 'Ajustes',
  'settings.language': 'Idioma',
  'settings.contrast': 'Alto contraste para el sol',
  'settings.large': 'Botones grandes para guantes',
  'settings.oneHanded': 'Uso con una mano (botones abajo)',
  'settings.battery': 'Ahorro de batería (ubicación con menos frecuencia)',
  'settings.location': 'Compartir mi ubicación con despacho mientras esté registrado',
  'settings.checkout': 'Registrar salida',
  'settings.checkoutBody':
    'Termina su turno. Los datos de residentes se borran de este teléfono; lo que no se haya enviado se queda hasta que se reciba.',
  'settings.signout': 'Cerrar sesión',
  'settings.policy': 'Ubicación: {reason}',
  'nav.home': 'Inicio',
  'nav.messages': 'Mensajes',
  'nav.sync': 'En este teléfono',
  'nav.settings': 'Ajustes',
  'wiped.body':
    'Su organización borró los datos de esta app en el teléfono. Inicie sesión de nuevo si todavía la necesita.',
  'common.back': 'Volver',
  'common.yes': 'Sí',
  'common.no': 'No',
  'common.error': 'Algo salió mal: {reason}',
};

const catalog: Record<Locale, Record<MessageKey, string>> = { en, es };

export function translate(
  locale: Locale,
  key: MessageKey,
  vars: Record<string, string | number> = {},
): string {
  const text = catalog[locale][key] ?? en[key];
  return text.replace(/\{(\w+)\}/g, (_, k: string) => String(vars[k] ?? `{${k}}`));
}

export function allKeys(): MessageKey[] {
  return Object.keys(en) as MessageKey[];
}

export function catalogFor(locale: Locale): Record<MessageKey, string> {
  return catalog[locale];
}

export const LocaleContext = createContext<{
  locale: Locale;
  t: (key: MessageKey, vars?: Record<string, string | number>) => string;
}>({ locale: 'en', t: (k, v) => translate('en', k, v) });

export function useT() {
  return useContext(LocaleContext);
}

export function deviceLocale(tag: string | null | undefined): Locale {
  return tag?.toLowerCase().startsWith('es') ? 'es' : 'en';
}
