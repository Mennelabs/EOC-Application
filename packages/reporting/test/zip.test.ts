/** The package ZIP: what goes in comes out, names in UTF-8, and the same content makes the same bytes. */
import { describe, expect, it } from 'vitest';
import { unzip } from '../../refdata/src/formats/shapefile.ts';
import { zip } from '../src/zip.ts';

describe('package zip', () => {
  it('round-trips files through a reader', () => {
    const when = new Date('2026-10-14T18:05:00Z');
    const files = [
      { name: 'README.txt', body: 'Exercise package\r\n'.repeat(50) },
      { name: 'datos/año.csv', body: Buffer.from('a,b\r\n1,2\r\n') },
      { name: 'empty.txt', body: '' },
    ];
    const z = zip(files, when);
    const out = unzip(z);
    expect([...out.keys()].sort()).toEqual(['README.txt', 'datos/año.csv', 'empty.txt']);
    expect(out.get('README.txt')!.toString()).toBe(files[0]!.body);
    expect(out.get('datos/año.csv')!.toString()).toBe('a,b\r\n1,2\r\n');
    expect(zip(files, when).equals(z)).toBe(true);
  });
});
