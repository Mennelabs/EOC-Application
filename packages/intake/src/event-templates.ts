/**
 * The event templates a county starts from, one per hazard (CON-02: "event
 * templates by hazard (tornado, flood, winter storm, wildfire) preset map
 * layers, intake questions, public messages and keywords"). The hazard type
 * chooses the intake questions (hazardsForEvent); the keywords are the
 * carrier-approved ones in docs/06 (DAMAGE, DAÑOS and DANOS), never a new word; the
 * map layers are those the situation map shows first; the public messages
 * are safety guidance drafted into Resources when the event opens, for the
 * public information officer to check and publish. Nothing here publishes on
 * its own. The Spanish is a reviewed draft (EQ-07) until a translator signs it.
 */

export const TEMPLATE_HAZARDS = ['tornado', 'flood', 'winter_storm', 'wildfire'] as const;
export type TemplateHazard = (typeof TEMPLATE_HAZARDS)[number];

/** The situation map's point layers a template may switch on (apps/web-console situation.tsx). */
export const MAP_LAYERS = [
  'reports',
  'dangerFlags',
  'verifiedDamage',
  'needs',
  'sites',
  'teams',
  'hazards',
  'roadClosures',
  'searched',
  'outages',
] as const;
export type MapLayer = (typeof MAP_LAYERS)[number];

export interface TemplateText {
  title: string;
  summary: string;
}

export interface TemplateMessage {
  /** Stable key; the drafted resource's slug is this plus the event's intake link. */
  key: string;
  texts: { en: TemplateText; es: TemplateText };
}

export interface EventTemplateConfig {
  keywords: string[];
  mapLayers: MapLayer[];
  messages: TemplateMessage[];
}

export interface EventTemplateDefault {
  hazardType: TemplateHazard;
  name: string;
  config: EventTemplateConfig;
}

/** docs/06: the opt-in keywords a county's toll-free number is verified for. */
const KEYWORDS = ['DAMAGE', 'DAÑOS', 'DANOS'];

export const EVENT_TEMPLATE_DEFAULTS: readonly EventTemplateDefault[] = [
  {
    hazardType: 'tornado',
    name: 'Tornado',
    config: {
      keywords: KEYWORDS,
      mapLayers: [
        'reports',
        'dangerFlags',
        'verifiedDamage',
        'searched',
        'hazards',
        'roadClosures',
        'sites',
      ],
      messages: [
        {
          key: 'tornado-power-lines',
          texts: {
            en: {
              title: 'Stay away from downed power lines',
              summary:
                'Treat every fallen line as live. Keep children and pets back and report it to the power company.',
            },
            es: {
              title: 'Manténgase lejos de los cables eléctricos caídos',
              summary:
                'Trate todo cable caído como si tuviera corriente. Mantenga alejados a niños y mascotas y avise a la compañía de luz.',
            },
          },
        },
        {
          key: 'tornado-cleanup-safety',
          texts: {
            en: {
              title: 'Clean up safely',
              summary:
                'Wear sturdy shoes, gloves and long sleeves. Do not go inside a home that has moved or has a damaged roof until it is checked.',
            },
            es: {
              title: 'Limpie con cuidado',
              summary:
                'Use zapatos resistentes, guantes y mangas largas. No entre a una casa que se movió o tiene el techo dañado hasta que la revisen.',
            },
          },
        },
      ],
    },
  },
  {
    hazardType: 'flood',
    name: 'Flood',
    config: {
      keywords: KEYWORDS,
      mapLayers: ['reports', 'dangerFlags', 'roadClosures', 'hazards', 'needs', 'sites', 'outages'],
      messages: [
        {
          key: 'flood-turn-around',
          texts: {
            en: {
              title: 'Do not walk or drive through flood water',
              summary:
                'Six inches of moving water can knock you down, and a foot of water can float a car. Turn around and find another way.',
            },
            es: {
              title: 'No camine ni maneje por agua de inundación',
              summary:
                'Seis pulgadas de agua en movimiento pueden tumbarle, y un pie de agua puede hacer flotar un carro. Dé la vuelta y busque otro camino.',
            },
          },
        },
        {
          key: 'flood-food-water',
          texts: {
            en: {
              title: 'Throw away food that touched flood water',
              summary:
                'Flood water carries sewage and chemicals. If your water may be unsafe, use bottled water until the county says your tap water is safe.',
            },
            es: {
              title: 'Tire la comida que tocó agua de inundación',
              summary:
                'El agua de inundación trae aguas negras y químicos. Si su agua puede no ser segura, use agua embotellada hasta que el condado diga que el agua de la llave es segura.',
            },
          },
        },
      ],
    },
  },
  {
    hazardType: 'winter_storm',
    name: 'Winter storm',
    config: {
      keywords: KEYWORDS,
      mapLayers: ['reports', 'dangerFlags', 'outages', 'needs', 'sites', 'roadClosures'],
      messages: [
        {
          key: 'winter-generators',
          texts: {
            en: {
              title: 'Run generators and grills outside only',
              summary:
                'Keep them at least 20 feet from doors and windows. Carbon monoxide has no smell and can kill. Never heat your home with an oven or grill.',
            },
            es: {
              title: 'Use generadores y parrillas solo afuera',
              summary:
                'Manténgalos al menos a 20 pies de puertas y ventanas. El monóxido de carbono no tiene olor y puede matar. Nunca caliente su casa con el horno o una parrilla.',
            },
          },
        },
        {
          key: 'winter-warm-place',
          texts: {
            en: {
              title: 'Find a warm place to stay',
              summary:
                'If your home has no heat, open warming centers and shelters are listed on this page. Check on older neighbors.',
            },
            es: {
              title: 'Busque un lugar cálido donde quedarse',
              summary:
                'Si su casa no tiene calefacción, los centros de calor y albergues abiertos están en esta página. Pregunte por sus vecinos mayores.',
            },
          },
        },
      ],
    },
  },
  {
    hazardType: 'wildfire',
    name: 'Wildfire',
    config: {
      keywords: KEYWORDS,
      mapLayers: ['reports', 'dangerFlags', 'roadClosures', 'hazards', 'sites', 'searched'],
      messages: [
        {
          key: 'wildfire-return',
          texts: {
            en: {
              title: 'Wait until officials say it is safe to go back',
              summary:
                'Burned areas can have hot spots, fallen trees and damaged gas or power lines. Wear sturdy shoes and gloves when you return.',
            },
            es: {
              title: 'Espere a que las autoridades digan que es seguro regresar',
              summary:
                'Las zonas quemadas pueden tener puntos calientes, árboles caídos y líneas de gas o luz dañadas. Use zapatos resistentes y guantes al regresar.',
            },
          },
        },
        {
          key: 'wildfire-smoke',
          texts: {
            en: {
              title: 'Protect yourself from smoke',
              summary:
                'Stay indoors with windows closed when it is smoky. A well-fitted N95 mask helps; a cloth mask does not.',
            },
            es: {
              title: 'Protéjase del humo',
              summary:
                'Quédese adentro con las ventanas cerradas cuando haya humo. Una mascarilla N95 bien ajustada ayuda; una de tela no.',
            },
          },
        },
      ],
    },
  },
];
