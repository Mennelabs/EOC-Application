/**
 * FEMA degree-of-damage guidance by home type (DCL:DEC-02, docs/05): what
 * reviewers read before setting a degree. Plain criteria in the order FEMA's
 * preliminary damage assessment guidance lists them; the reviewer decides,
 * nothing here is computed from the answers.
 */
export type Degree = 'affected' | 'minor' | 'major' | 'destroyed';

export interface MatrixRow {
  degree: Degree;
  title: string;
  conventional: string;
  manufactured: string;
}

export const DEGREES: Degree[] = ['affected', 'minor', 'major', 'destroyed'];

export const FEMA_MATRIX: MatrixRow[] = [
  {
    degree: 'affected',
    title: 'Affected',
    conventional:
      'Cosmetic damage only: shingles or siding missing, cracked windows, water in a crawl space or basement without living space, debris on the lot. The home is habitable.',
    manufactured:
      'Cosmetic damage: skirting, siding or windows damaged, water under the home only. Still level and on its supports; habitable.',
  },
  {
    degree: 'minor',
    title: 'Minor',
    conventional:
      'Non-structural damage that makes part of the home unusable for a short time: a few inches of water in living space (under about 18 inches), roof covering damaged with the deck intact, a broken window letting weather in, HVAC or water heater damaged. Repairable without major work.',
    manufactured:
      'Water in the living space under about 6 inches, roof or exterior wall damaged but intact, utilities damaged. The home has not shifted on its supports.',
  },
  {
    degree: 'major',
    title: 'Major',
    conventional:
      'Structural damage or failure of a major component: roof deck or structure damaged, exterior wall or foundation damaged, water in living space above about 18 inches, the home not habitable without extensive repair.',
    manufactured:
      'Water in the living space above about 6 inches, the home shifted off its supports but repairable, roof or wall structure damaged. Not habitable without major repair.',
  },
  {
    degree: 'destroyed',
    title: 'Destroyed',
    conventional:
      'Total loss or unsafe to repair: collapse, walls or foundation failed, water over the roofline, the frame off the foundation, or the cost to repair is not reasonable.',
    manufactured:
      'Total loss: the home off its supports and the frame bent, roof gone with walls failed, water over the roofline, or burned.',
  },
];

/** Which column applies to the home type the resident chose. */
export function matrixColumn(homeType: string | null): 'conventional' | 'manufactured' {
  return homeType === 'mobile_home' ? 'manufactured' : 'conventional';
}

/**
 * A reason drafted from the record for the reviewer to finish (BRD:FR-12.02,
 * DCL:DEC-02): the matrix criteria for the degree they chose, what the
 * resident reported about the damage, and the photos on file. Nothing here
 * is computed by a model; the reviewer picks the degree and says what they
 * checked (PHO-12: the severity suggestion stays off).
 */
export function draftDegreeReason(input: {
  degree: string;
  column: 'conventional' | 'manufactured';
  facts: { prompt: string; answer: string }[];
  photoCount: number;
}): string {
  const row = FEMA_MATRIX.find((r) => r.degree === input.degree);
  const home = input.column === 'manufactured' ? 'manufactured home' : 'conventional home';
  const first = row
    ? `${row.title} by the FEMA matrix (${home}): ${row[input.column]}`
    : input.degree === 'no_damage'
      ? 'No damage: nothing reported or seen meets the lowest FEMA degree.'
      : 'Cannot tell from the record: more evidence or a field visit is needed.';
  const facts =
    input.facts.length > 0
      ? `Reported by the resident: ${input.facts.map((f) => `${f.prompt} ${f.answer}.`).join(' ')}`
      : 'Reported by the resident: nothing about the damage itself.';
  const photos =
    input.photoCount === 0
      ? 'Photos on file: none.'
      : `Photos on file: ${input.photoCount} (reviewed in the photo panel).`;
  return `${first}\n${facts}\n${photos}\nWhat I checked: `;
}
