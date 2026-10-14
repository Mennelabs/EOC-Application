/**
 * State FIPS codes and postal abbreviations (ANSI INCITS 38). Some sources
 * ask for the abbreviation (CMS, the National Weather Service) rather than
 * the code. 29 is Missouri, the state of the WESTWIND exercise.
 */
export const STATE_ABBR: Readonly<Record<string, string>> = {
  '01': 'AL',
  '02': 'AK',
  '04': 'AZ',
  '05': 'AR',
  '06': 'CA',
  '08': 'CO',
  '09': 'CT',
  '10': 'DE',
  '11': 'DC',
  '12': 'FL',
  '13': 'GA',
  '15': 'HI',
  '16': 'ID',
  '17': 'IL',
  '18': 'IN',
  '19': 'IA',
  '20': 'KS',
  '21': 'KY',
  '22': 'LA',
  '23': 'ME',
  '24': 'MD',
  '25': 'MA',
  '26': 'MI',
  '27': 'MN',
  '28': 'MS',
  '29': 'MO',
  '30': 'MT',
  '31': 'NE',
  '32': 'NV',
  '33': 'NH',
  '34': 'NJ',
  '35': 'NM',
  '36': 'NY',
  '37': 'NC',
  '38': 'ND',
  '39': 'OH',
  '40': 'OK',
  '41': 'OR',
  '42': 'PA',
  '44': 'RI',
  '45': 'SC',
  '46': 'SD',
  '47': 'TN',
  '48': 'TX',
  '49': 'UT',
  '50': 'VT',
  '51': 'VA',
  '53': 'WA',
  '54': 'WV',
  '55': 'WI',
  '56': 'WY',
  '60': 'AS',
  '66': 'GU',
  '69': 'MP',
  '72': 'PR',
  '78': 'VI',
};

export function stateAbbr(stateFips: string): string {
  const abbr = STATE_ABBR[stateFips];
  if (!abbr) throw new Error(`unknown state FIPS code ${stateFips}`);
  return abbr;
}

/** "Westwind County" → "WESTWIND", the way CMS and others name counties. */
export function countyNameKey(name: string): string {
  return name
    .replace(/\s+(County|Parish|Borough|Census Area|Municipality|city and borough)$/i, '')
    .trim()
    .toUpperCase();
}
