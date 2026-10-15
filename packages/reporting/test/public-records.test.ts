/**
 * The public-records release rules (SEC-13, SEC-11): no restricted,
 * sensitive or criminal-justice column of any kind of record leaves; nor do
 * security values, links to people or places, free-form detail, household
 * needs or residents' reference codes; a column the dictionary does not know
 * is withheld; the ZIP carries a README, the redaction log and one CSV per
 * kind of record asked for.
 */
import { describe, expect, it } from 'vitest';
import { dictionary } from '@cg/db';
import { unzip } from '../../refdata/src/formats/shapefile.ts';
import {
  RECORD_TYPE_KEYS,
  RECORD_TYPES,
  buildPublicRecords,
  releasePlan,
  releaseRule,
} from '../src/public-records.ts';

describe('public-records release rules', () => {
  it('SEC-13: no restricted, sensitive or criminal-justice column of any kind of record is released', () => {
    for (const type of RECORD_TYPE_KEYS) {
      const table = RECORD_TYPES[type].table;
      expect(dictionary[table], table).toBeDefined();
      const { released, withheld } = releasePlan(type);
      expect(released.length + withheld.length).toBe(Object.keys(dictionary[table]!).length);
      for (const c of released) {
        expect(['public', 'internal'], `${table}.${c}`).toContain(dictionary[table]![c]!.c);
        expect(c, `${table}.${c}`).not.toMatch(/_enc$|_hash$|_bidx$|_party_id$|cji|^location_id$/);
      }
    }
  });

  it('SEC-13: what residents told us, how to reach them and where they are never leave', () => {
    const withheld = (t: string, c: string) => releaseRule(t, c);
    expect(withheld('report', 'answers')).toEqual({ release: false, why: 'sensitive' });
    expect(withheld('report', 'answers_enc')).toEqual({ release: false, why: 'restricted' });
    expect(withheld('report', 'reporter_party_id')).toEqual({
      release: false,
      why: 'links to a person or place',
    });
    expect(withheld('report', 'location_id').release).toBe(false);
    expect(withheld('report', 'need_signals')).toEqual({ release: false, why: 'household needs' });
    expect(withheld('report', 'reference_code')).toEqual({
      release: false,
      why: 'security value',
    });
    expect(withheld('need', 'detail')).toEqual({ release: false, why: 'sensitive' });
    expect(withheld('mission', 'caller_enc').release).toBe(false);
    expect(withheld('mission', 'summary').release).toBe(false);
    expect(withheld('mission', 'cji_ref')).toEqual({ release: false, why: 'criminal justice' });
    expect(withheld('mission', 'case_reference')).toEqual({
      release: false,
      why: 'criminal justice',
    });
    expect(withheld('mission_event', 'detail')).toEqual({
      release: false,
      why: 'free-form detail',
    });
    expect(withheld('field_message', 'body').release).toBe(false);
    expect(withheld('comms_log', 'message').release).toBe(false);
    // What a release is for stays: a mission's number and state, a site's public details.
    expect(withheld('mission', 'reference')).toEqual({ release: true });
    expect(withheld('mission', 'state')).toEqual({ release: true });
    expect(withheld('site', 'name')).toEqual({ release: true });
    // A column the dictionary does not know is treated as restricted.
    expect(withheld('report', 'something_new')).toEqual({ release: false, why: 'restricted' });
  });

  it('SEC-13: the ZIP has a README, the redaction log and one CSV per kind asked for', () => {
    const at = new Date('2026-10-15T12:00:00Z');
    const built = buildPublicRecords(
      {
        event: { name: 'Exercise flood' },
        rows: {
          missions: [
            {
              reference: '20261015-001',
              state: 'closed',
              kind: 'welfare_check',
              created_at: at,
              required_credentials: ['cdl', 'first aid'],
            },
          ],
          sites: [],
        },
      },
      {
        requestReference: 'PRR-2026-014',
        recordTypes: ['missions', 'sites'],
        from: '2026-10-01',
        to: null,
      },
      { productName: 'Test Product', generatedAt: at },
    );
    expect(built.counts).toEqual({ missions: 1, sites: 0 });
    const files = unzip(built.body);
    expect([...files.keys()].sort()).toEqual([
      'README.txt',
      'REDACTIONS.csv',
      'missions.csv',
      'sites.csv',
    ]);
    const readme = files.get('README.txt')!.toString('utf8');
    expect(readme).toContain('Request: PRR-2026-014');
    expect(readme).toContain('2026-10-01 to the end');
    expect(readme).toContain('A person must review this file before it is released.');
    const missions = files.get('missions.csv')!.toString('utf8');
    expect(missions).toContain('20261015-001');
    expect(missions).toContain('cdl; first aid');
    expect(missions.split('\r\n')[0]).not.toContain('summary');
    const redactions = files.get('REDACTIONS.csv')!.toString('utf8');
    expect(redactions).toContain('missions,summary,sensitive');
    expect(redactions).toContain('missions,caller_enc,restricted');
    expect(built.withheldColumns).toBe(redactions.trim().split('\r\n').length - 1);
  });
});
