/**
 * US National Grid (FLD-05): UTM against PostGIS (`ST_Transform` to EPSG
 * 326xx/327xx, the reference values below), the 100 km letters by the AA
 * scheme, precision digits, parsing and the round trip.
 */
import { describe, expect, it } from 'vitest';
import {
  fromUsng,
  fromUtm,
  latitudeBand,
  squareLetters,
  toUsng,
  toUtm,
  utmZone,
} from '../src/usng.ts';

/** lat, lon, PostGIS easting/northing (EPSG:326zz or 327zz), expected USNG. */
const REFERENCE = [
  {
    name: 'Washington Monument',
    lat: 38.8895,
    lon: -77.0353,
    zone: 18,
    h: 'N',
    e: 323478.06,
    n: 4306483.24,
    usng: '18S UJ 23478 06483',
  },
  {
    name: 'Harmon County (WESTWIND seed)',
    lat: 38.79,
    lon: -90.87,
    zone: 15,
    h: 'N',
    e: 684993.66,
    n: 4295627.81,
    usng: '15S XC 84993 95627',
  },
  {
    name: 'Gateway Arch',
    lat: 38.6247,
    lon: -90.1848,
    zone: 15,
    h: 'N',
    e: 745077.62,
    n: 4278890.51,
    usng: '15S YC 45077 78890',
  },
  {
    name: 'Honolulu',
    lat: 21.3069,
    lon: -157.8583,
    zone: 4,
    h: 'N',
    e: 618417.09,
    n: 2356542.46,
    usng: '4Q FJ 18417 56542',
  },
  {
    name: 'Anchorage',
    lat: 61.2181,
    lon: -149.9003,
    zone: 6,
    h: 'N',
    e: 344247.21,
    n: 6790536.87,
    usng: '6V UN 44247 90536',
  },
  {
    name: 'Sydney (southern hemisphere)',
    lat: -33.8688,
    lon: 151.2093,
    zone: 56,
    h: 'S',
    e: 334368.63,
    n: 6250948.35,
    usng: '56H LH 34368 50948',
  },
  {
    name: 'Oslo (zone 32 exception)',
    lat: 59.9139,
    lon: 10.7522,
    zone: 32,
    h: 'N',
    e: 597979.9,
    n: 6643118.99,
    usng: '32V NM 97979 43118',
  },
] as const;

describe('UTM and USNG (FLD-05)', () => {
  it('matches PostGIS to a tenth of a metre and writes the standard grid string', () => {
    for (const r of REFERENCE) {
      const u = toUtm(r.lat, r.lon);
      expect(u.zone, r.name).toBe(r.zone);
      expect(u.hemisphere, r.name).toBe(r.h);
      expect(Math.abs(u.easting - r.e), r.name).toBeLessThan(0.1);
      expect(Math.abs(u.northing - r.n), r.name).toBeLessThan(0.1);
      expect(toUsng(r.lat, r.lon), r.name).toBe(r.usng);
      const back = fromUtm(u);
      expect(Math.abs(back.lat - r.lat), r.name).toBeLessThan(1e-8);
      expect(Math.abs(back.lon - r.lon), r.name).toBeLessThan(1e-8);
    }
  });

  it('zones, bands and square letters follow the standard, including the Norway exception', () => {
    expect(utmZone(38.79, -90.87)).toBe(15);
    expect(utmZone(59.9, 10.75)).toBe(32);
    expect(utmZone(59.9, 4.0)).toBe(32); // would be 31 without the exception
    expect(utmZone(78, 10)).toBe(33); // Svalbard
    expect(latitudeBand(38.79)).toBe('S');
    expect(latitudeBand(-33.87)).toBe('H');
    expect(latitudeBand(83.9)).toBe('X');
    expect(() => latitudeBand(85)).toThrow(RangeError);
    expect(squareLetters(18, 323478, 4306483)).toBe('UJ');
    expect(squareLetters(15, 684993, 4295627)).toBe('XC');
  });

  it('precision digits truncate to the cell, and the compact form has no spaces', () => {
    expect(toUsng(38.8895, -77.0353, 4)).toBe('18S UJ 2347 0648');
    expect(toUsng(38.8895, -77.0353, 3)).toBe('18S UJ 234 064');
    expect(toUsng(38.8895, -77.0353, 1)).toBe('18S UJ 2 0');
    expect(toUsng(38.8895, -77.0353, 2, true)).toBe('18SUJ2306');
    expect(() => toUsng(38.8895, -77.0353, 6)).toThrow(RangeError);
  });

  it('parses spaced and compact strings to the cell centre within half a cell, in both hemispheres', () => {
    for (const r of REFERENCE) {
      const p = fromUsng(r.usng);
      expect(p.precisionM).toBe(1);
      const dLat = Math.abs(p.lat - r.lat) * 111_320;
      const dLon = Math.abs(p.lon - r.lon) * 111_320 * Math.cos((r.lat * Math.PI) / 180);
      expect(dLat, r.name).toBeLessThan(0.75);
      expect(dLon, r.name).toBeLessThan(0.75);
    }
    const coarse = fromUsng('18SUJ2306');
    expect(coarse.precisionM).toBe(1000);
    expect(Math.abs(coarse.lat - 38.8895) * 111_320).toBeLessThan(1000);
    expect(() => fromUsng('18S UJ 234 06')).toThrow(/same number of digits/);
    expect(() => fromUsng('hello')).toThrow(/not a USNG/);
    expect(() => fromUsng('18S AJ 23478 06483')).toThrow(/column letter/); // A is not in zone 18's column set
  });
});
