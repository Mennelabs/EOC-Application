/**
 * Frontline role modules (layer-4 task J; docs/04 FL:FR-01, FR-04, FR-05,
 * FR-06, FR-08, FR-09, FR-14, FR-15, FR-19, FR-24, FR-28; FLD-01, FLD-12,
 * FLD-13): each module is a short form described here once and drawn by
 * app/record/[kind].tsx. A module appears on the home screen only when the
 * person's role allows its action (the server checks again). Saving puts a
 * `record.<kind>` command in the outbox, so the work is kept on the phone
 * and sent when there is signal. Words in English and Spanish; the Spanish
 * is a draft for professional review (EQ-07).
 */
import type { Locale } from './i18n';

type L = { en: string; es: string };

export type FieldKind =
  | {
      type: 'choice';
      key: string;
      label: L;
      options: { value: string; label: L }[];
      initial?: string;
    }
  | { type: 'multi'; key: string; label: L; options: { value: string; label: L }[] }
  | { type: 'number'; key: string; label: L; min: number; max: number; initial: number }
  | { type: 'text'; key: string; label: L; hint?: L; max: number; required?: boolean }
  | { type: 'multiline'; key: string; label: L; hint?: L; max: number; required?: boolean }
  | { type: 'toggle'; key: string; label: L }
  | { type: 'site'; key: string; label: L; required: boolean }
  /** One of the person's work orders on this phone (FL:FR-19). */
  | { type: 'mission'; key: string; label: L; required: boolean }
  | { type: 'checklist'; key: string; label: L; items: { value: string; label: L }[] }
  | { type: 'signature'; key: string; label: L };

export interface Module {
  kind: string;
  action: string;
  readAction: string;
  title: L;
  intro: L;
  /** The current position (and an optional landmark) is attached. */
  where: boolean;
  /** Photos can document the record (FLD-07); never on children's or health records. */
  photos: boolean;
  fields: FieldKind[];
  /** A plain, non-personal line for the list on this phone (FLD-14). */
  summary: (v: Record<string, unknown>, locale: Locale) => string;
}

const o = (value: string, en: string, es: string) => ({ value, label: { en, es } });
const note: FieldKind = {
  type: 'multiline',
  key: 'note',
  label: { en: 'Note (optional)', es: 'Nota (opcional)' },
  hint: {
    en: 'What you saw or did. Do not write names or phone numbers.',
    es: 'Lo que vio o hizo. No escriba nombres ni teléfonos.',
  },
  max: 2000,
};
const site = (required: boolean): FieldKind => ({
  type: 'site',
  key: 'siteId',
  label: { en: 'Site', es: 'Sitio' },
  required,
});
const pick = (m: Module, key: string, value: unknown, locale: Locale): string => {
  const f = m.fields.find((x) => x.key === key);
  if (f && (f.type === 'choice' || f.type === 'multi'))
    return f.options.find((x) => x.value === value)?.label[locale] ?? String(value ?? '');
  return String(value ?? '');
};

export const MODULES: Module[] = [
  {
    kind: 'search_mark',
    action: 'search_mark.write',
    readAction: 'search_mark.read',
    title: { en: 'Search mark', es: 'Marca de búsqueda' },
    intro: {
      en: 'One mark per structure, so no building is searched twice (FEMA marking).',
      es: 'Una marca por estructura, para que ningún edificio se busque dos veces (marcado FEMA).',
    },
    where: true,
    photos: true,
    fields: [
      {
        type: 'choice',
        key: 'entryType',
        label: { en: 'Search', es: 'Búsqueda' },
        initial: 'primary',
        options: [
          o('primary', 'Primary', 'Primaria'),
          o('secondary', 'Secondary', 'Secundaria'),
          o('exterior_only', 'Outside only', 'Solo exterior'),
        ],
      },
      {
        type: 'number',
        key: 'occupantsFound',
        label: { en: 'People found alive', es: 'Personas encontradas con vida' },
        min: 0,
        max: 500,
        initial: 0,
      },
      {
        type: 'number',
        key: 'occupantsRemoved',
        label: { en: 'People removed', es: 'Personas evacuadas' },
        min: 0,
        max: 500,
        initial: 0,
      },
      {
        type: 'number',
        key: 'victims',
        label: { en: 'Deceased', es: 'Fallecidos' },
        min: 0,
        max: 500,
        initial: 0,
      },
      {
        type: 'multi',
        key: 'hazards',
        label: { en: 'Hazards', es: 'Peligros' },
        options: [
          o('gas', 'Gas', 'Gas'),
          o('electrical', 'Electrical', 'Eléctrico'),
          o('water', 'Water', 'Agua'),
          o('structural', 'Structural', 'Estructural'),
          o('hazmat', 'Hazardous materials', 'Materiales peligrosos'),
          o('animals', 'Animals', 'Animales'),
          o('other', 'Other', 'Otro'),
        ],
      },
      note,
    ],
    summary: (v, l) =>
      `${l === 'es' ? 'Marca' : 'Mark'}: ${String(v['occupantsFound'] ?? 0)}/${String(v['occupantsRemoved'] ?? 0)}`,
  },
  {
    kind: 'placard',
    action: 'placard.write',
    readAction: 'placard.read',
    title: { en: 'Safety placard', es: 'Aviso de seguridad' },
    intro: {
      en: 'Record the placard you posted, with a photo of it on the building.',
      es: 'Registre el aviso que colocó, con una foto en el edificio.',
    },
    where: true,
    photos: true,
    fields: [
      {
        type: 'choice',
        key: 'kind',
        label: { en: 'Placard', es: 'Aviso' },
        options: [
          o('inspected', 'Inspected (green)', 'Inspeccionado (verde)'),
          o('restricted_use', 'Restricted use (yellow)', 'Uso restringido (amarillo)'),
          o('unsafe', 'Unsafe (red)', 'Inseguro (rojo)'),
        ],
      },
      note,
    ],
    summary: (v, l) => pick(MODULES[1]!, 'kind', v['kind'], l),
  },
  {
    kind: 'road_status',
    action: 'road_status.write',
    readAction: 'road_status.read',
    title: { en: 'Road status', es: 'Estado de la vía' },
    intro: {
      en: 'Say what a road is like now. Your position is attached.',
      es: 'Diga cómo está la vía ahora. Se adjunta su posición.',
    },
    where: true,
    photos: true,
    fields: [
      {
        type: 'text',
        key: 'name',
        label: { en: 'Road', es: 'Vía' },
        hint: { en: 'For example: Route 9 at Mill Creek', es: 'Por ejemplo: Ruta 9 en Mill Creek' },
        max: 200,
        required: true,
      },
      {
        type: 'choice',
        key: 'status',
        label: { en: 'Status', es: 'Estado' },
        options: [
          o('closed', 'Closed', 'Cerrada'),
          o('one_lane', 'One lane', 'Un carril'),
          o('impassable', 'Impassable', 'Intransitable'),
          o('open', 'Open', 'Abierta'),
        ],
      },
      {
        type: 'text',
        key: 'reason',
        label: { en: 'Why (optional)', es: 'Por qué (opcional)' },
        max: 300,
      },
    ],
    summary: (v, l) => `${String(v['name'] ?? '')}: ${pick(MODULES[2]!, 'status', v['status'], l)}`,
  },
  {
    kind: 'debris_ticket',
    action: 'debris_ticket.write',
    readAction: 'debris_ticket.read',
    title: { en: 'Debris load ticket', es: 'Boleto de carga de escombros' },
    intro: {
      en: 'One ticket per truck load, for FEMA Public Assistance records.',
      es: 'Un boleto por carga de camión, para los registros de Asistencia Pública de FEMA.',
    },
    where: true,
    photos: true,
    fields: [
      {
        type: 'text',
        key: 'ticketNumber',
        label: { en: 'Ticket number', es: 'Número de boleto' },
        max: 40,
        required: true,
      },
      {
        type: 'choice',
        key: 'debrisType',
        label: { en: 'Debris', es: 'Escombros' },
        options: [
          o('vegetative', 'Vegetative', 'Vegetal'),
          o('construction', 'Construction and demolition', 'Construcción y demolición'),
          o('mixed', 'Mixed', 'Mixtos'),
          o('white_goods', 'Appliances', 'Electrodomésticos'),
          o('hazardous', 'Hazardous', 'Peligrosos'),
          o('electronic', 'Electronics', 'Electrónicos'),
          o('other', 'Other', 'Otro'),
        ],
      },
      { type: 'text', key: 'truckId', label: { en: 'Truck', es: 'Camión' }, max: 40 },
      {
        type: 'number',
        key: 'truckCapacityCy',
        label: { en: 'Truck capacity (cubic yards)', es: 'Capacidad del camión (yardas cúbicas)' },
        min: 0,
        max: 500,
        initial: 20,
      },
      {
        type: 'choice',
        key: 'loadPercent',
        label: { en: 'How full', es: 'Qué tan lleno' },
        initial: '100',
        options: [
          o('25', 'A quarter', 'Un cuarto'),
          o('50', 'Half', 'La mitad'),
          o('75', 'Three quarters', 'Tres cuartos'),
          o('100', 'Full', 'Lleno'),
        ],
      },
      {
        type: 'text',
        key: 'disposalSite',
        label: { en: 'Disposal site', es: 'Sitio de disposición' },
        max: 200,
      },
    ],
    summary: (v) => `#${String(v['ticketNumber'] ?? '')}`,
  },
  {
    kind: 'inspection',
    action: 'inspection.write',
    readAction: 'inspection.read',
    title: { en: 'Site inspection', es: 'Inspección del sitio' },
    intro: {
      en: 'Health and safety checks. Illness is a count only, never a name.',
      es: 'Revisión de salud y seguridad. Las enfermedades son solo un número, nunca un nombre.',
    },
    where: false,
    photos: true,
    fields: [
      site(false),
      {
        type: 'choice',
        key: 'kind',
        label: { en: 'Kind of site', es: 'Tipo de sitio' },
        initial: 'shelter',
        options: [
          o('shelter', 'Shelter', 'Albergue'),
          o('feeding_site', 'Feeding site', 'Sitio de comidas'),
          o('pod', 'Distribution point', 'Punto de distribución'),
          o('warehouse', 'Warehouse', 'Almacén'),
          o('other', 'Other', 'Otro'),
        ],
      },
      {
        type: 'checklist',
        key: 'checklist',
        label: { en: 'Checks', es: 'Revisiones' },
        items: [
          o('potable_water', 'Safe drinking water', 'Agua potable'),
          o('handwashing', 'Handwashing', 'Lavado de manos'),
          o('food_temps', 'Food temperatures', 'Temperatura de alimentos'),
          o('restrooms', 'Restrooms clean', 'Baños limpios'),
          o('waste', 'Trash removed', 'Basura retirada'),
          o('ventilation', 'Air and temperature', 'Aire y temperatura'),
          o('pests', 'No pests', 'Sin plagas'),
        ],
      },
      {
        type: 'choice',
        key: 'result',
        label: { en: 'Result', es: 'Resultado' },
        options: [
          o('pass', 'Pass', 'Aprobado'),
          o('corrective', 'Needs correcting', 'Necesita corrección'),
          o('fail', 'Fail', 'No aprobado'),
        ],
      },
      {
        type: 'number',
        key: 'illnessCount',
        label: { en: 'People ill (count)', es: 'Personas enfermas (número)' },
        min: 0,
        max: 10_000,
        initial: 0,
      },
      note,
    ],
    summary: (v, l) => pick(MODULES[4]!, 'result', v['result'], l),
  },
  {
    kind: 'pet_intake',
    action: 'pet_intake.write',
    readAction: 'pet_intake.read',
    title: { en: 'Pet intake', es: 'Ingreso de mascota' },
    intro: {
      en: 'Linked to the owner’s reference code, never their name.',
      es: 'Vinculado al código de referencia del dueño, nunca a su nombre.',
    },
    where: false,
    photos: true,
    fields: [
      site(false),
      {
        type: 'text',
        key: 'ownerReferenceCode',
        label: { en: 'Owner’s reference code (optional)', es: 'Código del dueño (opcional)' },
        max: 20,
      },
      {
        type: 'choice',
        key: 'species',
        label: { en: 'Animal', es: 'Animal' },
        options: [
          o('dog', 'Dog', 'Perro'),
          o('cat', 'Cat', 'Gato'),
          o('bird', 'Bird', 'Ave'),
          o('livestock', 'Livestock', 'Ganado'),
          o('other', 'Other', 'Otro'),
        ],
      },
      {
        type: 'text',
        key: 'description',
        label: { en: 'Description', es: 'Descripción' },
        hint: { en: 'Color, size, collar', es: 'Color, tamaño, collar' },
        max: 300,
      },
      {
        type: 'choice',
        key: 'status',
        label: { en: 'Status', es: 'Estado' },
        initial: 'sheltered',
        options: [
          o('sheltered', 'Sheltered here', 'Albergado aquí'),
          o('found_report', 'Found', 'Encontrado'),
          o('lost_report', 'Reported lost', 'Reportado perdido'),
          o('reunited', 'Back with owner', 'Devuelto al dueño'),
          o('transferred', 'Transferred', 'Trasladado'),
        ],
      },
    ],
    summary: (v, l) => pick(MODULES[5]!, 'species', v['species'], l),
  },
  {
    kind: 'site_walkthrough',
    action: 'walkthrough.write',
    readAction: 'walkthrough.read',
    title: { en: 'Facility walk-through', es: 'Recorrido de la instalación' },
    intro: {
      en: 'Photos before and after use, who holds keys, and issues.',
      es: 'Fotos antes y después del uso, quién tiene las llaves y los problemas.',
    },
    where: false,
    photos: true,
    fields: [
      site(true),
      {
        type: 'choice',
        key: 'phase',
        label: { en: 'When', es: 'Cuándo' },
        options: [
          o('before', 'Before use', 'Antes del uso'),
          o('after', 'After use', 'Después del uso'),
        ],
      },
      {
        type: 'text',
        key: 'keyHolders',
        label: { en: 'Key holders', es: 'Quién tiene llaves' },
        max: 300,
      },
      { type: 'multiline', key: 'issues', label: { en: 'Issues', es: 'Problemas' }, max: 2000 },
    ],
    summary: (v, l) => pick(MODULES[6]!, 'phase', v['phase'], l),
  },
  {
    kind: 'right_of_entry',
    action: 'right_of_entry.write',
    readAction: 'right_of_entry.read',
    title: { en: 'Right of entry', es: 'Permiso de entrada' },
    intro: {
      en: 'The resident signs on this phone before work starts. Their name and signature are kept private.',
      es: 'El residente firma en este teléfono antes de empezar. Su nombre y su firma se guardan en privado.',
    },
    where: true,
    photos: false,
    fields: [
      {
        type: 'choice',
        key: 'signerRole',
        label: { en: 'The person signing is', es: 'La persona que firma es' },
        options: [
          o('owner', 'The owner', 'El dueño'),
          o('landlord', 'The landlord', 'El arrendador'),
          o('tenant', 'A renter', 'Un inquilino'),
          o('agent', 'Someone acting for the owner', 'Alguien en nombre del dueño'),
        ],
      },
      {
        type: 'text',
        key: 'signerName',
        label: { en: 'Name of the person signing', es: 'Nombre de quien firma' },
        max: 200,
        required: true,
      },
      {
        type: 'multiline',
        key: 'scope',
        label: { en: 'Work allowed', es: 'Trabajo permitido' },
        hint: {
          en: 'For example: remove the tree from the roof and tarp it',
          es: 'Por ejemplo: quitar el árbol del techo y cubrirlo',
        },
        max: 1000,
        required: true,
      },
      {
        type: 'toggle',
        key: 'landlordConsent',
        label: {
          en: 'The owner has agreed to this work (needed when a renter signs)',
          es: 'El dueño aceptó este trabajo (necesario si firma un inquilino)',
        },
      },
      { type: 'signature', key: 'signatureSvg', label: { en: 'Signature', es: 'Firma' } },
    ],
    summary: (v, l) => pick(MODULES[7]!, 'signerRole', v['signerRole'], l),
  },
  {
    kind: 'canvass_visit',
    action: 'canvass_visit.write',
    readAction: 'canvass_visit.read',
    title: { en: 'Door-to-door visit', es: 'Visita puerta a puerta' },
    intro: {
      en: 'What happened at this door. “No one home” schedules a revisit for you.',
      es: 'Qué pasó en esta puerta. “Nadie en casa” le programa otra visita.',
    },
    where: true,
    photos: true,
    fields: [
      {
        type: 'choice',
        key: 'outcome',
        label: { en: 'What happened', es: 'Qué pasó' },
        options: [
          o('spoke_with_resident', 'Spoke with a resident', 'Hablé con un residente'),
          o('assisted_report', 'Helped them report', 'Les ayudé a reportar'),
          o('no_one_home', 'No one home', 'Nadie en casa'),
          o('refused', 'Did not want help', 'No quisieron ayuda'),
          o('vacant', 'Empty home', 'Casa vacía'),
          o('unsafe', 'Unsafe to approach', 'Inseguro acercarse'),
          o('referred', 'Referred to a partner', 'Referido a un socio'),
        ],
      },
      {
        type: 'toggle',
        key: 'doorHangerLeft',
        label: { en: 'Left a door hanger', es: 'Dejé un aviso en la puerta' },
      },
      {
        type: 'text',
        key: 'language',
        label: { en: 'Language spoken (optional)', es: 'Idioma hablado (opcional)' },
        max: 20,
      },
      note,
    ],
    summary: (v, l) => pick(MODULES[8]!, 'outcome', v['outcome'], l),
  },
  {
    kind: 'interpreter_request',
    action: 'interpreter.request',
    readAction: 'interpreter.read',
    title: { en: 'Ask for an interpreter', es: 'Pedir un intérprete' },
    intro: {
      en: 'An interpreter joins by phone or video, or comes in person.',
      es: 'Un intérprete se une por teléfono o video, o viene en persona.',
    },
    where: false,
    photos: false,
    fields: [
      {
        type: 'choice',
        key: 'language',
        label: { en: 'Language', es: 'Idioma' },
        options: [
          o('spanish', 'Spanish', 'Español'),
          o('vietnamese', 'Vietnamese', 'Vietnamita'),
          o('arabic', 'Arabic', 'Árabe'),
          o('chinese', 'Chinese', 'Chino'),
          o('haitian_creole', 'Haitian Creole', 'Criollo haitiano'),
          o('asl', 'American Sign Language', 'Lengua de señas americana'),
          o('other', 'Another language (say in the note)', 'Otro idioma (dígalo en la nota)'),
        ],
      },
      {
        type: 'choice',
        key: 'mode',
        label: { en: 'How', es: 'Cómo' },
        initial: 'phone',
        options: [
          o('phone', 'Phone', 'Teléfono'),
          o('video', 'Video', 'Video'),
          o('in_person', 'In person', 'En persona'),
        ],
      },
      site(false),
      note,
    ],
    summary: (v, l) => pick(MODULES[9]!, 'language', v['language'], l),
  },
  {
    kind: 'shelter_incident',
    action: 'shelter_incident.write',
    readAction: 'shelter_incident.read',
    title: { en: 'Quiet incident log', es: 'Registro discreto de incidentes' },
    intro: {
      en: 'Kept private for the shelter lead. Not a substitute for 911.',
      es: 'Se guarda en privado para el responsable del albergue. No sustituye al 911.',
    },
    where: false,
    photos: false,
    fields: [
      site(true),
      {
        type: 'choice',
        key: 'kind',
        label: { en: 'Kind', es: 'Tipo' },
        options: [
          o('medical', 'Medical', 'Médico'),
          o('behavioral', 'Behavior', 'Conducta'),
          o('safety', 'Safety', 'Seguridad'),
          o('security', 'Security', 'Vigilancia'),
          o('facility', 'Building', 'Edificio'),
          o('other', 'Other', 'Otro'),
        ],
      },
      {
        type: 'multiline',
        key: 'summary',
        label: { en: 'What happened', es: 'Qué pasó' },
        max: 2000,
        required: true,
      },
    ],
    summary: (v, l) => pick(MODULES[10]!, 'kind', v['kind'], l),
  },
  {
    kind: 'health_note',
    action: 'health_note.write',
    readAction: 'health_note.read',
    title: { en: 'Health note or request', es: 'Nota o pedido de salud' },
    intro: {
      en: 'For health staff only. Every view is recorded.',
      es: 'Solo para personal de salud. Cada consulta queda registrada.',
    },
    where: false,
    photos: false,
    fields: [
      site(false),
      {
        type: 'choice',
        key: 'kind',
        label: { en: 'Kind', es: 'Tipo' },
        options: [
          o('medication_request', 'Medication request', 'Pedido de medicamento'),
          o('equipment_replacement', 'Replace equipment', 'Reponer equipo'),
          o('assessment', 'Assessment', 'Evaluación'),
          o('follow_up', 'Follow-up', 'Seguimiento'),
          o('other', 'Other', 'Otro'),
        ],
      },
      {
        type: 'multiline',
        key: 'note',
        label: { en: 'Note', es: 'Nota' },
        max: 4000,
        required: true,
      },
    ],
    summary: (v, l) => pick(MODULES[11]!, 'kind', v['kind'], l),
  },
  {
    kind: 'equipment_use',
    action: 'equipment_use.write',
    readAction: 'equipment_use.read',
    title: { en: 'Equipment used', es: 'Equipo usado' },
    intro: {
      en: 'Which equipment ran on a work order and for how many hours today. Your own hours come from check-in.',
      es: 'Qué equipo funcionó en una orden de trabajo y cuántas horas hoy. Sus propias horas salen del registro de llegada.',
    },
    where: false,
    photos: false,
    fields: [
      {
        type: 'mission',
        key: 'missionId',
        label: { en: 'Work order', es: 'Orden de trabajo' },
        required: true,
      },
      {
        type: 'choice',
        key: 'equipment',
        label: { en: 'Equipment', es: 'Equipo' },
        options: [
          o('chainsaw', 'Chainsaw', 'Motosierra'),
          o('pump', 'Pump', 'Bomba'),
          o('generator', 'Generator', 'Generador'),
          o('skid_steer', 'Skid steer or loader', 'Minicargadora'),
          o('dump_truck', 'Dump truck', 'Camión de volteo'),
          o('chipper', 'Chipper', 'Astilladora'),
          o('pressure_washer', 'Pressure washer', 'Hidrolavadora'),
          o('dehumidifier', 'Dehumidifier', 'Deshumidificador'),
          o('other', 'Other', 'Otro'),
        ],
      },
      {
        type: 'text',
        key: 'equipmentNote',
        label: {
          en: 'Unit number, or what it was (optional)',
          es: 'Número de unidad, o qué era (opcional)',
        },
        max: 120,
      },
      {
        type: 'number',
        key: 'hours',
        label: { en: 'Hours it ran today', es: 'Horas que funcionó hoy' },
        min: 1,
        max: 24,
        initial: 1,
      },
    ],
    summary: (v, l) =>
      `${pick(MODULES[MODULES.length - 1]!, 'equipment', v['equipment'], l)}: ${String(v['hours'] ?? '')} h`,
  },
];

export const moduleByKind = new Map(MODULES.map((m) => [m.kind, m]));

/** Every label and option in both languages (EQ-07); the test checks none is empty. */
export function allLabels(): L[] {
  const out: L[] = [];
  for (const m of MODULES) {
    out.push(m.title, m.intro);
    for (const f of m.fields) {
      out.push(f.label);
      if ('hint' in f && f.hint) out.push(f.hint);
      if (f.type === 'choice' || f.type === 'multi') out.push(...f.options.map((x) => x.label));
      if (f.type === 'checklist') out.push(...f.items.map((x) => x.label));
    }
  }
  return out;
}

/** The body of the `record.<kind>` command from the form's values; numbers where the server wants numbers. */
export function commandBody(m: Module, values: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of m.fields) {
    const v = values[f.key];
    if (v === undefined || v === null || v === '') continue;
    if (Array.isArray(v) && v.length === 0 && f.type !== 'multi') continue;
    if (f.key === 'loadPercent') out[f.key] = Number(v);
    else if (typeof v === 'string') out[f.key] = v.trim();
    else out[f.key] = v;
  }
  return out;
}

/** What the form needs before it can be saved. */
export function missing(m: Module, values: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const f of m.fields) {
    const v = values[f.key];
    const empty = v === undefined || v === null || (typeof v === 'string' && !v.trim());
    if (f.type === 'choice' && empty && !f.initial) out.push(f.key);
    if ((f.type === 'text' || f.type === 'multiline') && f.required && empty) out.push(f.key);
    if ((f.type === 'site' || f.type === 'mission') && f.required && empty) out.push(f.key);
    if (f.type === 'signature' && empty) out.push(f.key);
  }
  return out;
}
