/**
 * Words for the codes the server sends (EQ-06): mission kinds, assignment
 * states, hazard kinds and the commands listed under "On this phone". Spanish
 * entries are drafts for professional review (EQ-07). Unknown codes fall back
 * to the code with spaces, never to nothing.
 */
import type { Locale } from './i18n';

type Vocab = Record<string, { en: string; es: string }>;

const missionKinds: Vocab = {
  welfare_check: { en: 'Welfare check', es: 'Visita de bienestar' },
  verification_route: { en: 'Verification route', es: 'Ruta de verificación' },
  cleanup_work_order: { en: 'Cleanup work order', es: 'Orden de limpieza' },
  delivery: { en: 'Delivery', es: 'Entrega' },
  outreach_sweep: { en: 'Outreach sweep', es: 'Recorrido de alcance' },
  site_staffing: { en: 'Site staffing', es: 'Personal para un sitio' },
  search: { en: 'Search', es: 'Búsqueda' },
  road_clearance: { en: 'Road clearance', es: 'Despeje de camino' },
  traffic_control: { en: 'Traffic control', es: 'Control de tránsito' },
  debris: { en: 'Debris', es: 'Escombros' },
  other: { en: 'Other', es: 'Otro' },
};

const assignmentStates: Vocab = {
  assigned: { en: 'Assigned', es: 'Asignado' },
  dispatched: { en: 'Sent to you, waiting for “Got it”', es: 'Enviado, esperando “Entendido”' },
  acknowledged: { en: 'Acknowledged', es: 'Confirmado' },
  declined: { en: 'Declined', es: 'Rechazado' },
  en_route: { en: 'On the way', es: 'En camino' },
  on_scene: { en: 'On scene', es: 'En el lugar' },
  cleared: { en: 'Cleared', es: 'Terminado' },
  released: { en: 'Released', es: 'Liberado' },
};

const hazardKinds: Vocab = {
  downed_line: { en: 'downed power line', es: 'cable eléctrico caído' },
  gas_leak: { en: 'gas leak', es: 'fuga de gas' },
  blocked_road: { en: 'blocked road', es: 'camino bloqueado' },
  unsafe_structure: { en: 'unsafe structure', es: 'estructura insegura' },
  flooding: { en: 'flooding', es: 'inundación' },
  debris: { en: 'debris', es: 'escombros' },
  weapons: { en: 'weapons reported', es: 'armas reportadas' },
  hazmat: { en: 'hazardous materials', es: 'materiales peligrosos' },
  medical_emergency: { en: 'medical emergency', es: 'emergencia médica' },
  mental_health_crisis: { en: 'mental health crisis', es: 'crisis de salud mental' },
  violence: { en: 'violence', es: 'violencia' },
  child_or_elder_involved: {
    en: 'child or older adult involved',
    es: 'niño o adulto mayor involucrado',
  },
  language_barrier: { en: 'language barrier', es: 'barrera de idioma' },
  utility_risk: { en: 'utility risk', es: 'riesgo de servicios públicos' },
  weather: { en: 'weather', es: 'clima' },
  public_health: { en: 'public health', es: 'salud pública' },
  animal: { en: 'animal', es: 'animal' },
  missing_person_concern: { en: 'possible missing person', es: 'posible persona desaparecida' },
  other: { en: 'other hazard', es: 'otro peligro' },
};

const commandKinds: Vocab = {
  'check_in.start': { en: 'Check-in', es: 'Registro de llegada' },
  'check_in.end': { en: 'Check-out', es: 'Registro de salida' },
  'position.batch': { en: 'Location for dispatch', es: 'Ubicación para despacho' },
  'team.status': { en: 'Team status (we’re OK)', es: 'Estado del equipo (estamos bien)' },
  'assignment.acknowledge': { en: '“Got it” for an assignment', es: '“Entendido” de una tarea' },
  'assignment.status': { en: 'Assignment status', es: 'Estado de una tarea' },
  'mission.narrative': { en: 'Note on a mission', es: 'Nota en una misión' },
  'hazard.report': { en: 'Hazard report', es: 'Reporte de peligro' },
  'field_message.receipt': { en: '“Got it” for a message', es: '“Entendido” de un mensaje' },
  'safety_alert.raise': { en: 'Help alert', es: 'Alerta de ayuda' },
  'reminder.acknowledge': { en: 'Reminder seen', es: 'Recordatorio visto' },
  'reminder.complete': { en: 'Reminder done', es: 'Recordatorio terminado' },
};

// FL:FR-08: the kinds of animal on the pet intake form.
const species: Vocab = {
  dog: { en: 'Dog', es: 'Perro' },
  cat: { en: 'Cat', es: 'Gato' },
  bird: { en: 'Bird', es: 'Ave' },
  livestock: { en: 'Livestock', es: 'Ganado' },
  other: { en: 'Other animal', es: 'Otro animal' },
};

const groups = { missionKinds, assignmentStates, hazardKinds, commandKinds, species };

export function label(
  locale: Locale,
  group: keyof typeof groups,
  code: string | null | undefined,
): string {
  if (!code) return '';
  return groups[group][code]?.[locale] ?? code.replace(/_/g, ' ');
}

export function vocabularyGroups() {
  return groups;
}
