/**
 * The FEMA degree of damage chosen from pictures and short descriptions for
 * the home type, never from definitions alone (FLD-08, DCL:DEC-02). The
 * descriptions follow the shape of FEMA's Preliminary Damage Assessment
 * guide (water depth in the living area, roof and walls, frame for
 * manufactured homes) and are exercise drafts: the county's approved FEMA
 * matrix job aid governs (plan §2 `job_aid`). Spanish is a draft for
 * professional review (EQ-07).
 */
import type { Locale } from './i18n';

export type Structure =
  'single_family' | 'manufactured' | 'apartment_building' | 'commercial' | 'public' | 'other';
export type Degree = 'no_damage' | 'affected' | 'minor' | 'major' | 'destroyed' | 'cannot_tell';
export type SweepDegree = Exclude<Degree, 'cannot_tell'> | 'cant_reach';

export const STRUCTURES: Structure[] = [
  'single_family',
  'manufactured',
  'apartment_building',
  'commercial',
  'public',
  'other',
];
export const DEGREES: Degree[] = [
  'no_damage',
  'affected',
  'minor',
  'major',
  'destroyed',
  'cannot_tell',
];
export const SWEEP_TAPS: SweepDegree[] = [
  'no_damage',
  'affected',
  'minor',
  'major',
  'destroyed',
  'cant_reach',
];

const structureNames: Record<Structure, { en: string; es: string }> = {
  single_family: { en: 'House', es: 'Casa' },
  manufactured: { en: 'Manufactured home', es: 'Casa prefabricada' },
  apartment_building: { en: 'Apartment building', es: 'Edificio de apartamentos' },
  commercial: { en: 'Business', es: 'Negocio' },
  public: { en: 'Public building', es: 'Edificio público' },
  other: { en: 'Other', es: 'Otro' },
};

const degreeNames: Record<SweepDegree | 'cannot_tell', { en: string; es: string }> = {
  no_damage: { en: 'No damage', es: 'Sin daños' },
  affected: { en: 'Affected', es: 'Afectada' },
  minor: { en: 'Minor', es: 'Daño menor' },
  major: { en: 'Major', es: 'Daño mayor' },
  destroyed: { en: 'Destroyed', es: 'Destruida' },
  cannot_tell: { en: 'Cannot tell', es: 'No se puede saber' },
  cant_reach: { en: 'Can’t reach', es: 'No se puede llegar' },
};

type Desc = Record<Degree, { en: string; es: string }>;

const conventional: Desc = {
  no_damage: { en: 'No visible damage.', es: 'No se ve ningún daño.' },
  affected: {
    en: 'Cosmetic only: a few shingles or siding pieces; water in the crawlspace or basement, not the living area. Livable.',
    es: 'Solo daño estético: algunas tejas o paneles; agua en el sótano o bajo el piso, no en la vivienda. Se puede vivir.',
  },
  minor: {
    en: 'Repairable: part of the roof, windows or doors damaged; water up to 18 inches in the living area. Livable after repairs.',
    es: 'Reparable: parte del techo, ventanas o puertas dañadas; agua de hasta 18 pulgadas en la vivienda. Se puede vivir tras reparar.',
  },
  major: {
    en: 'Structural: large parts of the roof or walls damaged; water 18 inches or more in the living area, or above the outlets. Not livable until repaired.',
    es: 'Estructural: grandes partes del techo o paredes dañadas; agua de 18 pulgadas o más en la vivienda, o por encima de los enchufes. No se puede vivir hasta reparar.',
  },
  destroyed: {
    en: 'Total loss: collapsed, or only the foundation or a few walls left; not repairable.',
    es: 'Pérdida total: derrumbada, o solo quedan los cimientos o algunas paredes; no se puede reparar.',
  },
  cannot_tell: {
    en: 'You cannot tell from where you are. Say why in the note.',
    es: 'No se puede saber desde donde está. Explique por qué en la nota.',
  },
};

const manufactured: Desc = {
  no_damage: conventional.no_damage,
  affected: {
    en: 'Cosmetic only: skirting or a few panels; water below the floor system. Livable.',
    es: 'Solo daño estético: el faldón o algunos paneles; agua por debajo del piso. Se puede vivir.',
  },
  minor: {
    en: 'Repairable: roof or walls partly damaged; water in the floor system (the belly), not above the floor. Livable after repairs.',
    es: 'Reparable: techo o paredes dañados en parte; agua dentro del piso, no por encima. Se puede vivir tras reparar.',
  },
  major: {
    en: 'Structural: water above the floor; walls or roof badly damaged; the home moved on its piers.',
    es: 'Estructural: agua por encima del piso; paredes o techo muy dañados; la casa se movió sobre sus soportes.',
  },
  destroyed: {
    en: 'Total loss: frame bent or twisted, home off its foundation, or water a foot or more above the floor.',
    es: 'Pérdida total: estructura doblada o torcida, la casa fuera de sus cimientos, o agua a un pie o más sobre el piso.',
  },
  cannot_tell: conventional.cannot_tell,
};

export function structureName(locale: Locale, s: Structure): string {
  return structureNames[s][locale];
}

export function degreeName(locale: Locale, d: SweepDegree | 'cannot_tell'): string {
  return degreeNames[d][locale];
}

export function describe(locale: Locale, s: Structure, d: Degree): string {
  return (s === 'manufactured' ? manufactured : conventional)[d][locale];
}

/** What the diagram draws for a degree: water height as a share of the wall, roof loss, walls standing. */
export function picture(
  s: Structure,
  d: Degree | SweepDegree,
): { water: number; roofLoss: number; collapsed: boolean } {
  const m = s === 'manufactured';
  switch (d) {
    case 'affected':
      return { water: m ? 0.04 : 0.06, roofLoss: 0.1, collapsed: false };
    case 'minor':
      return { water: m ? 0.1 : 0.22, roofLoss: 0.3, collapsed: false };
    case 'major':
      return { water: m ? 0.3 : 0.5, roofLoss: 0.6, collapsed: false };
    case 'destroyed':
      return { water: 0.8, roofLoss: 1, collapsed: true };
    default:
      return { water: 0, roofLoss: 0, collapsed: false };
  }
}
