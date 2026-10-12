/**
 * Default question graph shipped with the product and seeded for every tenant
 * (INT-01). Content follows docs/01 §11, DCL:DEC-01/17, NED-01/03, WIT-01,
 * HLP-01, ORG-01 and the resident mockups. English is the source; Spanish
 * strings are drafts for professional translation and community review
 * before go-live (EQ-07). Tone: calm, plain, no blame (INT-17/18); every
 * prompt is checked at or below grade 5 by the lint (INT-08).
 */
import { parseGraph, type QuestionGraph } from '../schema.ts';

const yesNoUnknown = (yes: [string, string], no: [string, string]) => [
  { value: 'yes', label: { en: yes[0], es: yes[1] } },
  { value: 'no', label: { en: no[0], es: no[1] } },
];

export const westwindGraph: QuestionGraph = parseGraph({
  key: 'default-home-damage',
  version: 1,
  title: { en: 'Report damage to a home', es: 'Reportar daños en una vivienda' },
  languages: ['en', 'es'],
  hazards: ['tornado', 'wind', 'flood', 'fire', 'winter_storm', 'other'],
  sections: [
    { id: 'safety', title: { en: 'Your safety', es: 'Su seguridad' } },
    { id: 'who', title: { en: 'Who is reporting', es: 'Quién reporta' } },
    { id: 'home', title: { en: 'Your home', es: 'Su hogar' } },
    { id: 'event', title: { en: 'What happened', es: 'Qué pasó' } },
    { id: 'photos', title: { en: 'Photos', es: 'Fotos' } },
    { id: 'needs', title: { en: 'What you need', es: 'Lo que necesita' } },
    { id: 'contact', title: { en: 'How to reach you', es: 'Cómo contactarle' } },
    {
      id: 'after',
      title: { en: 'A few more optional questions', es: 'Unas preguntas opcionales más' },
    },
  ],
  emergencyInstructions: {
    en: 'Call 911 now. If you cannot call, text 911 where that works, or ask someone near you to call. Stay away from downed power lines, gas smells and rising water. Your answers so far are saved. You can come back to this report at any time.',
    es: 'Llame al 911 ahora. Si no puede llamar, envíe un mensaje al 911 donde funcione, o pida a alguien cerca que llame. Aléjese de cables caídos, olor a gas y agua que sube. Sus respuestas están guardadas. Puede volver a este reporte en cualquier momento.',
  },
  photoSafetyLine: {
    en: 'Do not go inside or near damage if it is unsafe.',
    es: 'No entre ni se acerque a los daños si no es seguro.',
  },
  shots: [
    {
      id: 'exterior',
      title: { en: 'Your whole home from outside', es: 'Toda su casa desde afuera' },
      example: {
        en: 'Stand back so the roof, walls and ground all fit in the picture.',
        es: 'Aléjese para que el techo, las paredes y el suelo quepan en la foto.',
      },
    },
    {
      id: 'worst',
      title: { en: 'The worst damage, up close', es: 'El peor daño, de cerca' },
      example: {
        en: 'Get close enough to show what broke or came off.',
        es: 'Acérquese lo suficiente para mostrar lo que se rompió o se desprendió.',
      },
    },
    {
      id: 'waterline',
      hazards: ['flood'],
      title: { en: 'The highest water mark', es: 'La marca más alta del agua' },
      example: {
        en: 'Put a common object next to it, like a chair or a broom, to show how high the water got.',
        es: 'Ponga un objeto común al lado, como una silla o una escoba, para mostrar la altura del agua.',
      },
    },
    {
      id: 'interior',
      optional: true,
      title: { en: 'Inside, if it is safe', es: 'Adentro, si es seguro' },
      example: {
        en: 'A room with damage, from the doorway.',
        es: 'Un cuarto con daños, desde la puerta.',
      },
    },
  ],
  needCategories: [
    {
      value: 'shelter_tonight',
      icon: 'bed',
      signal: 'no_shelter',
      label: { en: 'A place to stay tonight', es: 'Un lugar donde quedarse esta noche' },
    },
    { value: 'food_water', icon: 'food', label: { en: 'Food or water', es: 'Comida o agua' } },
    {
      value: 'cleanup_tarp',
      icon: 'tarp',
      label: { en: 'Cleanup help or a tarp', es: 'Ayuda con la limpieza o una lona' },
    },
    {
      value: 'medical_power',
      icon: 'medical',
      signal: 'medical',
      label: {
        en: 'Medical equipment or power for it',
        es: 'Equipo médico o electricidad para usarlo',
      },
    },
    { value: 'transportation', icon: 'car', label: { en: 'A ride somewhere', es: 'Transporte' } },
    {
      value: 'pets',
      icon: 'paw',
      label: { en: 'Help with pets or animals', es: 'Ayuda con mascotas o animales' },
    },
    {
      value: 'someone_to_talk',
      icon: 'chat',
      label: { en: 'Someone to talk to', es: 'Alguien con quien hablar' },
    },
    { value: 'other', icon: 'more', label: { en: 'Something else', es: 'Otra cosa' } },
  ],
  consentOrgTypes: [
    {
      value: 'volunteer_cleanup',
      label: { en: 'Volunteer cleanup groups', es: 'Grupos voluntarios de limpieza' },
      description: {
        en: 'Groups like the Salvation Army, Team Rubicon or local churches that clear debris and put tarps on roofs.',
        es: 'Grupos como el Ejército de Salvación, Team Rubicon o iglesias locales que retiran escombros y ponen lonas en los techos.',
      },
    },
    {
      value: 'relief_agencies',
      label: { en: 'Relief agencies', es: 'Agencias de ayuda' },
      description: {
        en: 'Groups like the Red Cross that run shelters and hand out food, water and supplies.',
        es: 'Grupos como la Cruz Roja que manejan albergues y reparten comida, agua y suministros.',
      },
    },
    {
      value: 'community_groups',
      label: { en: 'Local community groups', es: 'Grupos comunitarios locales' },
      description: {
        en: 'Nonprofits in the county that help with repairs and other needs that take longer.',
        es: 'Organizaciones sin fines de lucro del condado que ayudan con necesidades a más largo plazo, como reparaciones y gestión de casos.',
      },
    },
    {
      value: 'faith_based',
      optIn: true,
      label: { en: 'Faith-based partners', es: 'Organizaciones religiosas' },
      description: {
        en: 'Churches and other faith groups the county works with. Help is offered to everyone.',
        es: 'Iglesias y otros grupos religiosos con los que trabaja el condado. La ayuda se ofrece a todos.',
      },
    },
  ],
  nodes: [
    {
      kind: 'question',
      id: 'danger_now',
      section: 'safety',
      answerType: 'single',
      required: true,
      allowUnknown: false,
      prompt: { en: 'Is anyone in danger right now?', es: '¿Hay alguien en peligro ahora mismo?' },
      why: {
        en: 'If yes, we show you who to call first.',
        es: 'Si es así, le mostramos a quién llamar primero.',
      },
      example: {
        en: 'For example: hurt, trapped, smelling gas, near a downed power line, or water rising inside.',
        es: 'Por ejemplo: herido, atrapado, olor a gas, cerca de un cable caído, o agua subiendo adentro.',
      },
      options: [
        {
          value: 'yes',
          label: { en: 'Yes, someone is in danger', es: 'Sí, alguien está en peligro' },
        },
        { value: 'no', label: { en: 'No, everyone is safe', es: 'No, todos están a salvo' } },
        { value: 'not_sure', label: { en: 'I am not sure', es: 'No estoy seguro' } },
      ],
      needSignal: { when: ['yes', 'not_sure'], signal: 'unsafe' },
    },
    {
      kind: 'info',
      id: 'danger_info',
      section: 'safety',
      tenantKey: 'intake.emergency_instructions',
      showIf: [{ q: 'danger_now', op: 'in', value: ['yes', 'not_sure'] }],
      title: { en: 'Please get help first', es: 'Primero busque ayuda' },
      body: {
        en: 'Call 911 now. If you cannot call, text 911 where that works, or ask someone near you to call. Stay away from downed power lines, gas smells and rising water. Your answers so far are saved. You can come back to this report at any time.',
        es: 'Llame al 911 ahora. Si no puede llamar, envíe un mensaje al 911 donde funcione, o pida a alguien cerca que llame. Aléjese de cables caídos, olor a gas y agua que sube. Sus respuestas están guardadas. Puede volver a este reporte en cualquier momento.',
      },
    },
    {
      kind: 'question',
      id: 'relationship',
      section: 'who',
      answerType: 'single',
      required: true,
      allowUnknown: false,
      prompt: { en: 'Is this your home?', es: '¿Es esta su casa?' },
      why: {
        en: 'We ask different questions for your own home, for someone you are helping, or for damage you saw.',
        es: 'Hacemos preguntas distintas si es su casa, si ayuda a alguien, o si vio daños.',
      },
      example: {
        en: 'Renters and owners both count as "my home".',
        es: 'Inquilinos y dueños cuentan como "mi casa".',
      },
      options: [
        { value: 'own_home', label: { en: 'Yes, I live here', es: 'Sí, vivo aquí' } },
        {
          value: 'helper',
          label: {
            en: 'No, I am helping someone who lives there',
            es: 'No, estoy ayudando a alguien que vive allí',
          },
        },
        {
          value: 'witness',
          label: { en: 'No, I saw damage to a home', es: 'No, vi daños en una casa' },
        },
        {
          value: 'organization',
          label: {
            en: 'I am reporting for a business, landlord or group',
            es: 'Reporto por un negocio, arrendador o grupo',
          },
        },
      ],
    },
    {
      kind: 'question',
      id: 'helper_name',
      section: 'who',
      answerType: 'text',
      relationships: ['helper'],
      prompt: { en: 'What is your name?', es: '¿Cuál es su nombre?' },
      why: {
        en: 'So the person you are helping knows who sent this report.',
        es: 'Para que la persona a la que ayuda sepa quién envió este reporte.',
      },
      example: { en: 'Any name you go by is fine.', es: 'Cualquier nombre que use está bien.' },
      classification: 'restricted',
    },
    {
      kind: 'question',
      id: 'helper_consent',
      section: 'who',
      answerType: 'single',
      relationships: ['helper'],
      required: true,
      allowUnknown: false,
      prompt: {
        en: 'Does this person know you are sending this report?',
        es: '¿Sabe esta persona que usted envía este reporte?',
      },
      why: {
        en: 'The report is about their home, so we record that they agreed.',
        es: 'El reporte es sobre su casa, así que registramos que estuvo de acuerdo.',
      },
      example: {
        en: 'For example: you asked them, or they asked you to do it.',
        es: 'Por ejemplo: usted les preguntó, o ellos se lo pidieron.',
      },
      options: [
        {
          value: 'yes',
          label: {
            en: 'Yes, they asked me or agreed',
            es: 'Sí, me lo pidieron o estuvieron de acuerdo',
          },
        },
        {
          value: 'cannot_ask',
          label: { en: 'I cannot ask them right now', es: 'No puedo preguntarles ahora' },
        },
      ],
    },
    {
      kind: 'question',
      id: 'subject_name',
      section: 'who',
      answerType: 'text',
      relationships: ['helper'],
      prompt: { en: 'Who are you helping?', es: '¿A quién está ayudando?' },
      why: {
        en: 'Their name goes on the report so help reaches the right household.',
        es: 'Su nombre va en el reporte para que la ayuda llegue al hogar correcto.',
      },
      example: {
        en: 'Their name, or how they are known to neighbors.',
        es: 'Su nombre, o como los conocen los vecinos.',
      },
      classification: 'restricted',
    },
    {
      kind: 'question',
      id: 'org_name',
      section: 'who',
      answerType: 'text',
      relationships: ['organization'],
      required: true,
      allowUnknown: false,
      prompt: {
        en: 'What is the name of your business or group?',
        es: '¿Cuál es el nombre de su negocio o grupo?',
      },
      why: {
        en: 'Each place you report gets its own record under this name.',
        es: 'Cada lugar que reporte tendrá su propio registro bajo este nombre.',
      },
      example: {
        en: 'For example: Oak Street Apartments, or Westwind Food Pantry.',
        es: 'Por ejemplo: Apartamentos Oak Street, o Despensa Westwind.',
      },
    },
    {
      kind: 'question',
      id: 'address',
      section: 'home',
      answerType: 'address',
      required: true,
      prompt: { en: 'Where is the home?', es: '¿Dónde está la casa?' },
      promptFor: { organization: { en: 'Where is this place?', es: '¿Dónde está este lugar?' } },
      why: {
        en: 'So the right people can find it. Any way you know it is fine.',
        es: 'Para que las personas indicadas puedan encontrarla. Cualquier forma en que la conozca está bien.',
      },
      example: {
        en: 'A street address, an apartment number, a road and a landmark, or a mobile home park and lot number. "No fixed address" is also fine.',
        es: 'Una dirección, un número de apartamento, un camino y un punto de referencia, o un parque de casas móviles y número de lote. "Sin domicilio fijo" también está bien.',
      },
      fema: 'address',
      classification: 'restricted',
    },
    {
      kind: 'question',
      id: 'home_type',
      section: 'home',
      answerType: 'single',
      picture: true,
      fema: 'structure_type',
      prompt: { en: 'What kind of home is it?', es: '¿Qué tipo de vivienda es?' },
      promptFor: {
        organization: { en: 'What kind of place is it?', es: '¿Qué tipo de lugar es?' },
      },
      why: {
        en: 'Different homes are checked in different ways, so this helps us look at yours fairly.',
        es: 'Cada tipo de vivienda se revisa de forma distinta, así que esto nos ayuda a evaluar la suya de manera justa.',
      },
      example: {
        en: 'For example: a house, an apartment, or a mobile home.',
        es: 'Por ejemplo: una casa, un apartamento o una casa móvil.',
      },
      options: [
        {
          value: 'house',
          picture: 'house',
          femaValue: 'single_family',
          label: { en: 'House', es: 'Casa' },
        },
        {
          value: 'apartment_condo',
          picture: 'apartment',
          femaValue: 'multi_family',
          label: { en: 'Apartment or condo', es: 'Apartamento o condominio' },
        },
        {
          value: 'mobile_manufactured',
          picture: 'mobile_home',
          femaValue: 'manufactured',
          label: { en: 'Mobile or manufactured home', es: 'Casa móvil o prefabricada' },
        },
        {
          value: 'business',
          picture: 'storefront',
          femaValue: 'business',
          label: { en: 'Business or other building', es: 'Negocio u otro edificio' },
        },
        {
          value: 'other',
          picture: 'other',
          femaValue: 'other',
          label: { en: 'Something else', es: 'Otra cosa' },
        },
      ],
    },
    {
      kind: 'question',
      id: 'units',
      section: 'home',
      answerType: 'number',
      min: 1,
      max: 5000,
      fema: 'units',
      relationships: ['organization'],
      showIf: [{ q: 'home_type', op: 'in', value: ['apartment_condo', 'business', 'other'] }],
      prompt: {
        en: 'How many homes are in this building?',
        es: '¿Cuántas viviendas hay en este edificio?',
      },
      why: {
        en: 'Each home in the building counts on its own.',
        es: 'Cada vivienda del edificio cuenta por separado.',
      },
      example: { en: 'For example: 12.', es: 'Por ejemplo: 12.' },
    },
    {
      kind: 'question',
      id: 'occupancy',
      section: 'home',
      answerType: 'single',
      fema: 'occupancy',
      relationships: ['own_home', 'helper'],
      prompt: { en: 'Do you rent or own this home?', es: '¿Renta o es dueño de esta casa?' },
      promptFor: {
        helper: { en: 'Do they rent or own the home?', es: '¿Rentan o son dueños de la casa?' },
      },
      why: {
        en: 'Renters and owners can both get help. This changes which questions we ask.',
        es: 'Inquilinos y dueños pueden recibir ayuda. Esto cambia las preguntas que hacemos.',
      },
      example: {
        en: 'If you stay with family or friends, choose "something else".',
        es: 'Si vive con familia o amigos, elija "otra cosa".',
      },
      options: [
        { value: 'rent', femaValue: 'renter', label: { en: 'I rent', es: 'Rento' } },
        { value: 'own', femaValue: 'owner', label: { en: 'I own it', es: 'Soy dueño' } },
        {
          value: 'other',
          femaValue: 'other',
          label: { en: 'Something else', es: 'Otra cosa' },
          hint: {
            en: 'Staying with family, no lease, or not sure who owns it',
            es: 'Vive con familia, sin contrato, o no sabe quién es el dueño',
          },
        },
      ],
    },
    {
      kind: 'question',
      id: 'primary_residence',
      section: 'home',
      answerType: 'single',
      fema: 'primary_residence',
      relationships: ['own_home', 'helper'],
      prompt: {
        en: 'Do you live here more than 6 months a year?',
        es: '¿Vive aquí más de 6 meses al año?',
      },
      promptFor: {
        helper: {
          en: 'Do they live here more than 6 months a year?',
          es: '¿Viven aquí más de 6 meses al año?',
        },
      },
      why: {
        en: 'Some programs count only the home where you live most of the year.',
        es: 'Algunos programas solo cuentan la casa donde vive la mayor parte del año.',
      },
      example: {
        en: 'A vacation home or a rental you do not live in would be "no".',
        es: 'Una casa de vacaciones o una renta donde no vive sería "no".',
      },
      options: yesNoUnknown(['Yes', 'Sí'], ['No', 'No']),
    },
    {
      kind: 'question',
      id: 'cause',
      section: 'event',
      answerType: 'single',
      picture: true,
      required: true,
      fema: 'cause',
      prompt: { en: 'What caused the damage?', es: '¿Qué causó el daño?' },
      why: {
        en: 'Flood and wind damage are checked in different ways.',
        es: 'Los daños por inundación y por viento se revisan de forma distinta.',
      },
      example: {
        en: 'Choose the main cause. You can add more in your own words later.',
        es: 'Elija la causa principal. Después puede agregar más con sus propias palabras.',
      },
      options: [
        {
          value: 'wind_tornado',
          picture: 'wind',
          label: { en: 'Wind or tornado', es: 'Viento o tornado' },
        },
        {
          value: 'flood',
          picture: 'flood',
          label: { en: 'Flood or water', es: 'Inundación o agua' },
        },
        { value: 'fire', picture: 'fire', label: { en: 'Fire', es: 'Fuego' } },
        {
          value: 'winter_storm',
          picture: 'snow',
          label: { en: 'Ice or snow', es: 'Hielo o nieve' },
        },
        { value: 'other', picture: 'other', label: { en: 'Something else', es: 'Otra cosa' } },
      ],
    },
    {
      kind: 'question',
      id: 'damage_types',
      section: 'event',
      answerType: 'multi',
      picture: true,
      required: true,
      fema: 'components',
      prompt: { en: 'What was damaged?', es: '¿Qué se dañó?' },
      promptFor: { witness: { en: 'What damage did you see?', es: '¿Qué daños vio?' } },
      why: {
        en: 'This helps us send the right kind of help.',
        es: 'Esto nos ayuda a enviar el tipo de ayuda correcto.',
      },
      example: { en: 'Choose all that fit.', es: 'Elija todo lo que aplique.' },
      options: [
        { value: 'roof', picture: 'roof', label: { en: 'Roof', es: 'Techo' } },
        {
          value: 'windows_doors',
          picture: 'window',
          label: { en: 'Windows or doors', es: 'Ventanas o puertas' },
        },
        {
          value: 'water_inside',
          picture: 'water',
          label: { en: 'Water inside', es: 'Agua adentro' },
        },
        {
          value: 'tree_on_home',
          picture: 'tree',
          label: { en: 'Tree on the home', es: 'Árbol sobre la casa' },
        },
        {
          value: 'moved_off_foundation',
          picture: 'shifted',
          label: { en: 'Home moved or tilted', es: 'La casa se movió o se inclinó' },
        },
        { value: 'walls', picture: 'wall', label: { en: 'Walls', es: 'Paredes' } },
        {
          value: 'outside_only',
          picture: 'yard',
          label: {
            en: 'Only outside: yard, fence or shed',
            es: 'Solo afuera: patio, cerca o cobertizo',
          },
        },
        { value: 'other', picture: 'other', label: { en: 'Something else', es: 'Otra cosa' } },
      ],
    },
    {
      kind: 'question',
      id: 'water_depth',
      section: 'event',
      answerType: 'single',
      hazards: ['flood'],
      fema: 'water_depth_band',
      prompt: {
        en: 'How high did the water get inside?',
        es: '¿Hasta dónde subió el agua adentro?',
      },
      why: {
        en: 'The water height tells us how badly the home was hurt.',
        es: 'La altura del agua nos dice qué tan grave fue el daño.',
      },
      example: {
        en: 'Look for a line on the wall. A kitchen counter is about 36 inches.',
        es: 'Busque una línea en la pared. Un mostrador de cocina mide unas 36 pulgadas.',
      },
      options: [
        { value: 'none', label: { en: 'No water came inside', es: 'No entró agua' } },
        {
          value: 'under_18in',
          label: {
            en: 'Under 18 inches, below the outlets',
            es: 'Menos de 18 pulgadas, debajo de los enchufes',
          },
        },
        { value: 'over_18in', label: { en: '18 inches or more', es: '18 pulgadas o más' } },
        { value: 'to_roof', label: { en: 'Up to the roof', es: 'Hasta el techo' } },
      ],
    },
    {
      kind: 'question',
      id: 'roof_state',
      section: 'event',
      answerType: 'single',
      hazards: ['wind', 'tornado'],
      picture: true,
      fema: 'roof',
      prompt: { en: 'How is the roof?', es: '¿Cómo está el techo?' },
      why: {
        en: 'A tarp crew needs to know how big the hole is.',
        es: 'El equipo de lonas necesita saber qué tan grande es el hueco.',
      },
      example: {
        en: 'Look from the street if it is not safe to go closer.',
        es: 'Mire desde la calle si no es seguro acercarse.',
      },
      options: [
        { value: 'fine', picture: 'roof_ok', label: { en: 'Looks fine', es: 'Se ve bien' } },
        {
          value: 'some_missing',
          picture: 'roof_shingles',
          label: { en: 'Some shingles or metal missing', es: 'Faltan algunas tejas o láminas' },
        },
        {
          value: 'large_hole',
          picture: 'roof_hole',
          label: { en: 'A big hole, you can see inside', es: 'Un hueco grande, se ve el interior' },
        },
        {
          value: 'gone',
          picture: 'roof_gone',
          label: { en: 'Most of the roof is gone', es: 'Casi todo el techo desapareció' },
        },
      ],
    },
    {
      kind: 'question',
      id: 'habitable',
      section: 'event',
      answerType: 'single',
      required: true,
      fema: 'habitable',
      relationships: ['own_home', 'helper'],
      prompt: {
        en: 'Can you still safely live in your home?',
        es: '¿Todavía puede vivir en su casa de forma segura?',
      },
      promptFor: {
        helper: {
          en: 'Can they still safely live in the home?',
          es: '¿Todavía pueden vivir en la casa de forma segura?',
        },
      },
      why: {
        en: 'This is the most important thing for us to know.',
        es: 'Esto es lo más importante que necesitamos saber.',
      },
      example: {
        en: 'No if the roof is open, the floor is wet, or there is no safe way in.',
        es: 'No si el techo está abierto, el piso está mojado, o no hay una entrada segura.',
      },
      options: [
        { value: 'yes', label: { en: 'Yes', es: 'Sí' } },
        { value: 'no', label: { en: 'No', es: 'No' } },
        { value: 'not_sure', label: { en: 'Not sure', es: 'No estoy seguro' } },
      ],
      needSignal: { when: ['no'], signal: 'displaced' },
    },
    {
      kind: 'question',
      id: 'tonight',
      section: 'event',
      answerType: 'single',
      required: true,
      fema: 'displaced',
      relationships: ['own_home', 'helper'],
      prompt: {
        en: 'Will you sleep somewhere else tonight?',
        es: '¿Dormirá en otro lugar esta noche?',
      },
      promptFor: {
        helper: {
          en: 'Will they sleep somewhere else tonight?',
          es: '¿Dormirán en otro lugar esta noche?',
        },
      },
      why: {
        en: 'We count how many people had to leave their homes.',
        es: 'Contamos cuántas personas tuvieron que dejar su casa.',
      },
      example: {
        en: 'With family, in a hotel, or in a shelter all count as "yes".',
        es: 'Con familia, en un hotel o en un albergue cuenta como "sí".',
      },
      options: yesNoUnknown(['Yes', 'Sí'], ['No, I am staying here', 'No, me quedo aquí']),
      needSignal: { when: ['yes'], signal: 'displaced' },
    },
    {
      kind: 'question',
      id: 'insurance',
      section: 'home',
      answerType: 'multi',
      fema: 'insurance',
      relationships: ['own_home', 'helper'],
      prompt: {
        en: 'Do you have insurance that may cover this damage?',
        es: '¿Tiene seguro que pueda cubrir este daño?',
      },
      promptFor: {
        helper: {
          en: 'Do they have insurance that may cover this damage?',
          es: '¿Tienen seguro que pueda cubrir este daño?',
        },
      },
      why: {
        en: 'Your answer does not change whether you can get help from volunteers.',
        es: 'Su respuesta no cambia si puede recibir ayuda de voluntarios.',
      },
      example: {
        en: 'Choose all that fit. "Not sure" is fine.',
        es: 'Elija todo lo que aplique. "No estoy seguro" está bien.',
      },
      options: [
        {
          value: 'home_or_renters',
          femaValue: 'homeowners_or_renters',
          label: { en: 'Home or renters insurance', es: 'Seguro de casa o de inquilino' },
        },
        {
          value: 'flood',
          femaValue: 'flood',
          label: { en: 'Flood insurance', es: 'Seguro contra inundaciones' },
        },
        {
          value: 'condo',
          femaValue: 'condominium',
          label: { en: 'Condo insurance', es: 'Seguro de condominio' },
        },
        {
          value: 'manufactured_home',
          femaValue: 'manufactured_home',
          label: { en: 'Mobile home insurance', es: 'Seguro de casa móvil' },
        },
        {
          value: 'sewer_backup',
          femaValue: 'sewer_backup_rider',
          label: { en: 'Sewer backup coverage', es: 'Cobertura por desbordamiento de drenaje' },
        },
        { value: 'none', femaValue: 'none', label: { en: 'No insurance', es: 'Sin seguro' } },
        {
          value: 'not_sure',
          femaValue: 'unknown',
          label: { en: 'Not sure', es: 'No estoy seguro' },
        },
      ],
    },
    {
      kind: 'question',
      id: 'utilities_out',
      section: 'home',
      answerType: 'multi',
      fema: 'utilities_out',
      relationships: ['own_home', 'helper', 'organization'],
      prompt: { en: 'What is not working at the home?', es: '¿Qué no funciona en la casa?' },
      promptFor: {
        organization: {
          en: 'What is not working at this place?',
          es: '¿Qué no funciona en este lugar?',
        },
      },
      why: {
        en: 'Crews plan around homes with no power or water.',
        es: 'Los equipos planifican según las casas sin luz o agua.',
      },
      example: { en: 'Choose all that fit.', es: 'Elija todo lo que aplique.' },
      options: [
        { value: 'electricity', label: { en: 'Electricity', es: 'Electricidad' } },
        { value: 'water', label: { en: 'Water', es: 'Agua' } },
        { value: 'gas', label: { en: 'Gas', es: 'Gas' } },
        { value: 'phone_internet', label: { en: 'Phone or internet', es: 'Teléfono o internet' } },
        { value: 'none', label: { en: 'Everything works', es: 'Todo funciona' } },
      ],
    },
    {
      kind: 'question',
      id: 'access',
      section: 'home',
      answerType: 'single',
      fema: 'inaccessible_reason',
      prompt: {
        en: 'Can a car reach the home right now?',
        es: '¿Puede llegar un carro a la casa ahora?',
      },
      promptFor: {
        organization: {
          en: 'Can a car reach this place right now?',
          es: '¿Puede llegar un carro a este lugar ahora?',
        },
      },
      why: {
        en: 'If not, we send people who can get there another way.',
        es: 'Si no, enviamos personas que puedan llegar de otra forma.',
      },
      example: {
        en: 'A tree across the road or a washed-out bridge would be "no".',
        es: 'Un árbol en el camino o un puente arrastrado sería "no".',
      },
      options: [
        { value: 'yes', femaValue: 'accessible', label: { en: 'Yes', es: 'Sí' } },
        {
          value: 'no_public_road',
          femaValue: 'public_road_or_bridge',
          label: {
            en: 'No, a public road or bridge is blocked',
            es: 'No, un camino o puente público está bloqueado',
          },
        },
        {
          value: 'no_private_road',
          femaValue: 'private_road_or_bridge',
          label: {
            en: 'No, our private road or bridge is out',
            es: 'No, nuestro camino o puente privado está dañado',
          },
        },
      ],
    },
    {
      kind: 'question',
      id: 'pre_existing',
      section: 'event',
      answerType: 'single',
      fema: 'pre_existing_damage',
      relationships: ['own_home', 'helper', 'organization'],
      prompt: {
        en: 'Was any of this damage there before the storm?',
        es: '¿Algo de este daño ya estaba antes de la tormenta?',
      },
      why: {
        en: 'We keep it in the record. It helps us compare homes fairly.',
        es: 'Lo guardamos en el registro. Ayuda a comparar las casas de manera justa.',
      },
      example: {
        en: 'For example: a leak that was already there.',
        es: 'Por ejemplo: una gotera que ya existía.',
      },
      options: [
        { value: 'some', femaValue: 'yes', label: { en: 'Yes, some of it', es: 'Sí, una parte' } },
        {
          value: 'none',
          femaValue: 'no',
          label: { en: 'No, it is all new', es: 'No, todo es nuevo' },
        },
      ],
    },
    {
      kind: 'question',
      id: 'employees_affected',
      section: 'event',
      answerType: 'number',
      min: 0,
      max: 100000,
      fema: 'employees_affected',
      relationships: ['organization'],
      showIf: [{ q: 'home_type', op: 'eq', value: 'business' }],
      prompt: { en: 'How many people work there?', es: '¿Cuántas personas trabajan allí?' },
      why: {
        en: 'Lost jobs are part of what the county reports.',
        es: 'Los empleos perdidos son parte de lo que reporta el condado.',
      },
      example: { en: 'For example: 8.', es: 'Por ejemplo: 8.' },
    },
    {
      kind: 'question',
      id: 'time_out_of_work',
      section: 'event',
      answerType: 'single',
      fema: 'expected_time_out_of_work',
      relationships: ['organization'],
      showIf: [{ q: 'home_type', op: 'eq', value: 'business' }],
      prompt: { en: 'How long will work stop?', es: '¿Por cuánto tiempo parará el trabajo?' },
      why: {
        en: 'This helps the county ask for the right kind of business help.',
        es: 'Esto ayuda al condado a pedir el tipo correcto de ayuda para negocios.',
      },
      example: { en: 'Your best guess is fine.', es: 'Su mejor cálculo está bien.' },
      options: [
        { value: 'days', label: { en: 'A few days', es: 'Unos días' } },
        { value: 'weeks', label: { en: 'A few weeks', es: 'Unas semanas' } },
        { value: 'months', label: { en: 'Months or longer', es: 'Meses o más' } },
      ],
    },
    {
      kind: 'free_text',
      id: 'own_words',
      section: 'event',
      title: { en: 'Or tell us in your own words', es: 'O cuéntenos con sus propias palabras' },
      body: {
        en: 'You can type or speak. Anything you say here is kept exactly as you said it.',
        es: 'Puede escribir o hablar. Lo que diga aquí se guarda tal como lo dijo.',
      },
    },
    {
      kind: 'photos',
      id: 'photos',
      section: 'photos',
      title: { en: 'Photos of the damage', es: 'Fotos del daño' },
      body: {
        en: 'Photos help, and they are optional. You can still send your report without them.',
        es: 'Las fotos ayudan y son opcionales. Puede enviar su reporte sin ellas.',
      },
    },
    {
      kind: 'needs',
      id: 'needs',
      section: 'needs',
      relationships: ['own_home', 'helper'],
      title: { en: 'Do you need help with any of these?', es: '¿Necesita ayuda con algo de esto?' },
      body: {
        en: 'Choose all that fit. Asking does not promise help, and it never changes your damage report.',
        es: 'Elija todo lo que aplique. Pedir no garantiza ayuda, y nunca cambia su reporte de daños.',
      },
    },
    {
      kind: 'consent',
      id: 'consent',
      section: 'needs',
      relationships: ['own_home', 'helper'],
      title: {
        en: 'Who may see your request for help?',
        es: '¿Quién puede ver su pedido de ayuda?',
      },
      body: {
        en: 'The county emergency office always sees your damage report. Say yes or no for each kind of group. No is the default, and you can change this later.',
        es: 'La oficina de emergencias del condado siempre ve su reporte de daños. Diga sí o no para cada tipo de grupo. No es la opción por defecto, y puede cambiarlo después.',
      },
    },
    {
      kind: 'question',
      id: 'contact_name',
      section: 'contact',
      answerType: 'text',
      classification: 'restricted',
      prompt: { en: 'What is your name?', es: '¿Cuál es su nombre?' },
      why: {
        en: 'So we know who to ask for. Any name you go by is fine.',
        es: 'Para saber por quién preguntar. Cualquier nombre que use está bien.',
      },
      example: { en: 'No ID is needed.', es: 'No se necesita identificación.' },
      relationships: ['own_home', 'witness'],
    },
    {
      kind: 'question',
      id: 'contact',
      section: 'contact',
      answerType: 'contact',
      classification: 'restricted',
      prompt: { en: 'How can we reach you?', es: '¿Cómo podemos contactarle?' },
      promptFor: {
        helper: {
          en: 'How can we reach you, the helper?',
          es: '¿Cómo podemos contactarle a usted, quien ayuda?',
        },
      },
      why: {
        en: 'Without a way to reach you, we cannot send your reference number or updates.',
        es: 'Sin una forma de contactarle, no podemos enviarle su número de referencia ni novedades.',
      },
      example: {
        en: 'A phone number or email. Tell us if you prefer a text, a call or an email.',
        es: 'Un número de teléfono o correo. Díganos si prefiere mensaje de texto, llamada o correo.',
      },
    },
    {
      kind: 'review',
      id: 'review',
      section: 'contact',
      title: { en: 'Check your answers', es: 'Revise sus respuestas' },
      body: {
        en: 'You can change anything before you send it.',
        es: 'Puede cambiar lo que quiera antes de enviar.',
      },
    },
  ],
  afterSubmission: [
    {
      kind: 'question',
      id: 'hurt_missing',
      section: 'after',
      answerType: 'single',
      fema: 'injured_or_missing',
      classification: 'sensitive',
      prompt: {
        en: 'Is anyone in your home hurt or missing?',
        es: '¿Hay alguien en su hogar herido o desaparecido?',
      },
      why: {
        en: 'The county tracks this to bring in medical and search help.',
        es: 'El condado lo registra para traer ayuda médica y de búsqueda.',
      },
      example: {
        en: 'If someone is in danger now, call 911.',
        es: 'Si alguien está en peligro ahora, llame al 911.',
      },
      options: yesNoUnknown(['Yes', 'Sí'], ['No', 'No']),
      needSignal: { when: ['yes'], signal: 'medical' },
    },
    {
      kind: 'question',
      id: 'lost_work',
      section: 'after',
      answerType: 'single',
      fema: 'disaster_unemployment',
      classification: 'sensitive',
      prompt: {
        en: 'Did anyone in your home lose work because of the storm?',
        es: '¿Alguien en su hogar perdió trabajo por la tormenta?',
      },
      why: {
        en: 'There is a program for lost work that regular unemployment does not cover.',
        es: 'Hay un programa para trabajo perdido que el desempleo regular no cubre.',
      },
      example: {
        en: 'For example: the shop you work at is closed, or you drive for yourself and cannot now.',
        es: 'Por ejemplo: la tienda donde trabaja cerró, o trabaja por su cuenta y ahora no puede.',
      },
      options: yesNoUnknown(['Yes', 'Sí'], ['No', 'No']),
    },
    {
      kind: 'question',
      id: 'household_size',
      section: 'after',
      answerType: 'number',
      min: 1,
      max: 50,
      fema: 'occupants',
      classification: 'sensitive',
      prompt: {
        en: 'How many people live in your home?',
        es: '¿Cuántas personas viven en su hogar?',
      },
      why: {
        en: 'This helps size shelter, food and cleanup help.',
        es: 'Esto ayuda a calcular el albergue, la comida y la ayuda de limpieza.',
      },
      example: {
        en: 'Count every person who lives there, children too.',
        es: 'Cuente a cada persona que vive allí, también a los niños.',
      },
    },
    {
      kind: 'question',
      id: 'access_needs',
      section: 'after',
      answerType: 'multi',
      classification: 'restricted',
      prompt: {
        en: 'Does anyone in your home need extra help?',
        es: '¿Alguien en su hogar necesita ayuda adicional?',
      },
      why: {
        en: 'Only the county staff who arrange this kind of help can see your answer.',
        es: 'Solo el personal del condado que organiza este tipo de ayuda puede ver su respuesta.',
      },
      example: {
        en: 'Choose all that fit. You never need to name a diagnosis.',
        es: 'Elija todo lo que aplique. Nunca tiene que nombrar un diagnóstico.',
      },
      options: [
        {
          value: 'mobility',
          label: { en: 'Uses a wheelchair or walker', es: 'Usa silla de ruedas o andador' },
        },
        {
          value: 'medical_power',
          label: {
            en: 'Needs medical equipment with power',
            es: 'Necesita equipo médico con electricidad',
          },
        },
        {
          value: 'cold_medicine',
          label: { en: 'Needs medicine kept cold', es: 'Necesita medicinas refrigeradas' },
        },
        {
          value: 'vision',
          label: { en: 'Is blind or has low vision', es: 'Es ciego o tiene baja visión' },
        },
        {
          value: 'hearing',
          label: { en: 'Is deaf or hard of hearing', es: 'Es sordo o tiene problemas de audición' },
        },
        {
          value: 'cognitive',
          label: {
            en: 'Needs help understanding or remembering',
            es: 'Necesita ayuda para entender o recordar',
          },
        },
        {
          value: 'infant',
          label: {
            en: 'Cares for a baby or small children',
            es: 'Cuida a un bebé o niños pequeños',
          },
        },
        {
          value: 'none',
          label: { en: 'No one needs extra help', es: 'Nadie necesita ayuda adicional' },
        },
      ],
      needSignal: { when: ['medical_power', 'cold_medicine'], signal: 'medical' },
    },
    {
      kind: 'question',
      id: 'accommodation',
      section: 'after',
      answerType: 'text',
      multiline: true,
      classification: 'restricted',
      prompt: {
        en: 'Is there a better way for us to reach you or meet you?',
        es: '¿Hay una mejor manera de contactarle o reunirnos con usted?',
      },
      why: {
        en: 'For example a sign language interpreter, large print, or a time of day that works. Only the access coordinator sees this.',
        es: 'Por ejemplo, un intérprete de lengua de señas, letra grande, o una hora del día que le convenga. Solo el coordinador de acceso lo ve.',
      },
      example: {
        en: 'For example: please text, I cannot hear calls.',
        es: 'Por ejemplo: por favor escriba, no puedo oír llamadas.',
      },
    },
    {
      kind: 'question',
      id: 'language_at_home',
      section: 'after',
      answerType: 'single',
      classification: 'sensitive',
      prompt: { en: 'What language do you speak at home?', es: '¿Qué idioma habla en casa?' },
      why: {
        en: 'We use this only in totals, to make sure help reaches every language.',
        es: 'Lo usamos solo en totales, para que la ayuda llegue a todos los idiomas.',
      },
      example: { en: 'You can skip this.', es: 'Puede saltar esta pregunta.' },
      options: [
        { value: 'en', label: { en: 'English', es: 'Inglés' } },
        { value: 'es', label: { en: 'Spanish', es: 'Español' } },
        { value: 'other', label: { en: 'Another language', es: 'Otro idioma' } },
        { value: 'prefer_not', label: { en: 'I would rather not say', es: 'Prefiero no decir' } },
      ],
    },
    {
      kind: 'question',
      id: 'age_band',
      section: 'after',
      answerType: 'single',
      classification: 'sensitive',
      prompt: {
        en: 'Is anyone in your home 65 or older?',
        es: '¿Hay alguien en su hogar de 65 años o más?',
      },
      why: {
        en: 'We use this only in totals, to plan help for older people.',
        es: 'Lo usamos solo en totales, para planear ayuda para personas mayores.',
      },
      example: { en: 'You can skip this.', es: 'Puede saltar esta pregunta.' },
      options: [
        { value: 'yes', label: { en: 'Yes', es: 'Sí' } },
        { value: 'no', label: { en: 'No', es: 'No' } },
        { value: 'prefer_not', label: { en: 'I would rather not say', es: 'Prefiero no decir' } },
      ],
    },
  ],
});
