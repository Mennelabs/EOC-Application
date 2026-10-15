/**
 * Places found by resource discovery (layer-7 task F; REC-13, REC-10): a
 * county's HSDS directory, an open-data CSV and a GeoJSON layer are read into
 * places that keep only what the source states; the kind comes from the words
 * only; one place from two sources has one fingerprint; the content hash moves
 * when something about the place changes; the pre-check uses the
 * recommendation rules. All names and addresses are fictional.
 */
import { describe, expect, it } from 'vitest';
import {
  contentHashOf,
  fingerprintOf,
  kindFromText,
  placesFromFeed,
  precheck,
  unknownOf,
  type FoundPlace,
} from '../src/discovery/places.ts';

const HSDS = JSON.stringify({
  total_items: 2,
  contents: [
    {
      id: 'loc-1',
      name: 'Exercise Grace Fellowship Church',
      latitude: 38.79,
      longitude: -90.85,
      addresses: [
        {
          address_type: 'physical',
          address_1: '12 Exercise Ave',
          city: 'Westwind',
          state_province: 'MO',
          postal_code: '63003',
        },
      ],
      accessibility: [{ description: 'Wheelchair accessible entrance' }],
      url: 'https://grace.example.org',
    },
    { id: 'loc-2', name: '' },
  ],
});

const CSV = [
  'Name,Street Address,City,ZIP,Latitude,Longitude,Type,Sq Ft,ADA,Kitchen,Generator,Parking',
  'Exercise Recreation Center,40 Park Rd,Harmon City,63005,38.81,-90.79,Community center,12000,Yes,yes,No,150',
  '"Exercise Middle School, East",9 School Ln,Westwind,63003,,,School,,,,,',
].join('\n');

const GEOJSON = JSON.stringify({
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      properties: { NAME: 'Exercise Fairgrounds Parking', address: '1 Fair Rd', zip: '63005' },
      geometry: { type: 'Point', coordinates: [-90.8, 38.78] },
    },
    { type: 'Feature', properties: {}, geometry: null },
  ],
});

describe('reading a county feed (REC-13)', () => {
  it('HSDS: name, physical address, position and what the directory states; nameless entries are skipped', () => {
    const [p, ...rest] = placesFromFeed('hsds', HSDS, 'https://211.example.org/locations');
    expect(rest).toEqual([]);
    expect(p).toEqual({
      name: 'Exercise Grace Fellowship Church',
      kind: 'place_of_worship',
      address: { line1: '12 Exercise Ave', city: 'Westwind', state: 'MO', postal: '63003' },
      position: { lat: 38.79, lon: -90.85 },
      attributes: { ada: true, website: 'https://grace.example.org/' },
      sourceLinks: ['https://211.example.org/locations#loc-1'],
    });
  });

  it('CSV: common column names; blanks stay unknown; quoted commas kept', () => {
    const [rec, school] = placesFromFeed('csv', CSV, 'https://data.example.gov/places.csv');
    expect(rec).toMatchObject({
      name: 'Exercise Recreation Center',
      kind: 'community_center',
      address: { line1: '40 Park Rd', city: 'Harmon City', postal: '63005' },
      position: { lat: 38.81, lon: -90.79 },
      attributes: {
        sqft: 12000,
        ada: true,
        kitchen: true,
        powerBackup: 'none',
        parkingSpaces: 150,
      },
    });
    expect(school).toMatchObject({
      name: 'Exercise Middle School, East',
      kind: 'school',
      position: null,
      attributes: {},
    });
    expect(unknownOf(school!.attributes)).toEqual([
      'sqft',
      'ada',
      'power backup',
      'kitchen',
      'showers',
      'pet policy',
      'parking spaces',
      'truck access',
    ]);
  });

  it('GeoJSON: points with a name; malformed content gives nothing, never a guess', () => {
    const places = placesFromFeed('geojson', GEOJSON, 'https://gis.example.gov/layer');
    expect(places).toHaveLength(1);
    expect(places[0]).toMatchObject({
      name: 'Exercise Fairgrounds Parking',
      kind: 'parking_lot',
      position: { lat: 38.78, lon: -90.8 },
    });
    expect(placesFromFeed('hsds', '<html>not json</html>', 'https://x.example.gov')).toEqual([]);
  });

  it('the kind comes from the words, and "other" when nothing fits', () => {
    expect(kindFromText('Iglesia Nueva Esperanza')).toBe('place_of_worship');
    expect(kindFromText('Harmon County Library')).toBe('government');
    expect(kindFromText('Exercise Warehouse 7')).toBe('other');
  });
});

describe('remembering a place (REC-13)', () => {
  const base: FoundPlace = {
    name: 'The Exercise Grace Fellowship Church',
    kind: 'place_of_worship',
    address: { line1: '12 Exercise Ave', city: 'Westwind', state: 'MO', postal: '63003-1234' },
    position: { lat: 38.79, lon: -90.85 },
    attributes: { ada: true },
    sourceLinks: ['https://211.example.org/locations#loc-1'],
  };

  it('one place from two sources has one fingerprint', () => {
    const other = { ...base, name: 'Exercise Grace Fellowship Church, Inc.', sourceLinks: [] };
    expect(fingerprintOf(other)).toBe(fingerprintOf(base));
    expect(fingerprintOf(base)).toBe('place:exercise grace fellowship church|63003');
    expect(
      fingerprintOf({
        ...base,
        change: 'closed',
        facilityId: '00000000-0000-4000-8000-000000000001',
      }),
    ).toBe('change:00000000-0000-4000-8000-000000000001:closed');
  });

  it('the content hash ignores where it was found, and moves when the place changes', () => {
    expect(contentHashOf({ ...base, sourceLinks: [] })).toBe(contentHashOf(base));
    expect(contentHashOf({ ...base, attributes: { ada: true, kitchen: true } })).not.toBe(
      contentHashOf(base),
    );
  });
});

describe('pre-check against the registry criteria (REC-13)', () => {
  it('uses the recommendation rules: needs information when only unknowns stand in the way', () => {
    const p = precheck({
      name: 'Exercise Recreation Center',
      kind: 'community_center',
      address: null,
      position: { lat: 38.81, lon: -90.79 },
      attributes: { sqft: 12000, ada: true, parkingSpaces: 150 },
      sourceLinks: [],
    });
    expect(p.shelter).toEqual({ fit: 'fits', reasons: [] });
    expect(p.feeding.fit).toBe('fits');
    expect(p.pod).toEqual({ fit: 'needs_information', reasons: ['semi-truck access unknown'] });
    expect(p.marc.fit).toBe('fits');
  });

  it('a lot fits a POD but is no shelter; no location means nothing can be checked', () => {
    const lot = precheck({
      name: 'Exercise Fairgrounds Parking',
      kind: 'parking_lot',
      address: null,
      position: { lat: 38.78, lon: -90.8 },
      attributes: { truckAccess: true },
      sourceLinks: [],
    });
    expect(lot.shelter.fit).toBe('does_not_fit');
    expect(lot.shelter.reasons).toContain('a parking lot is not a shelter');
    expect(lot.pod.fit).toBe('fits');
    const nowhere = precheck({
      name: 'Exercise Hall',
      kind: 'other',
      address: null,
      position: null,
      attributes: {},
      sourceLinks: [],
    });
    expect(nowhere.feeding.reasons).toContain(
      'location unknown, so hazards and distance cannot be checked',
    );
  });
});
