/**
 * The damage classifier's evaluation (AIG-08, PHO-12, PHO-13): the manifest
 * is read into cases, every case goes to the classifier as the worker sends
 * it, accuracy is reported overall and by hazard, home type and income band,
 * and the run fails when a group is materially less accurate or accuracy fell
 * against the baseline. No photo is ever kept; the loader here serves bytes.
 */
import { describe, expect, it } from 'vitest';
import {
  evaluatePhotos,
  parsePhotoManifest,
  scorePhotos,
  type PhotoCase,
} from '../src/evaluation/photos.ts';
import type { DamageClassifier, DamageDegree } from '../src/types.ts';
import { fakeProvider } from '../src/providers/fake.ts';

const MANIFEST = `case,file,degree,hazard,home_type,income_band
# exercise set, not real homes
a,a-1.jpg,major,flood,single_family,band 1
a,a-2.jpg,major,flood,single_family,band 1
b,b-1.jpg,destroyed,tornado,mobile_home,band 5
c,c-1.jpg,minor,flood,,
`;

describe('photo manifest', () => {
  it('groups photos by case and reads the labels', () => {
    const cases = parsePhotoManifest(MANIFEST);
    expect(cases).toEqual([
      {
        id: 'a',
        files: ['a-1.jpg', 'a-2.jpg'],
        degree: 'major',
        hazard: 'flood',
        homeType: 'conventional',
        homeTypeAnswer: 'single_family',
        incomeBand: 'band 1',
      },
      {
        id: 'b',
        files: ['b-1.jpg'],
        degree: 'destroyed',
        hazard: 'tornado',
        homeType: 'manufactured',
        homeTypeAnswer: 'mobile_home',
        incomeBand: 'band 5',
      },
      {
        id: 'c',
        files: ['c-1.jpg'],
        degree: 'minor',
        hazard: 'flood',
        homeType: null,
        homeTypeAnswer: null,
        incomeBand: null,
      },
    ]);
  });

  it('refuses a missing column, an unknown degree and a case with two degrees', () => {
    expect(() => parsePhotoManifest('case,file\na,a.jpg')).toThrow(/degree/);
    expect(() => parsePhotoManifest('case,file,degree\na,a.jpg,severe')).toThrow(/degree must be/);
    expect(() => parsePhotoManifest('case,file,degree\na,1.jpg,minor\na,2.jpg,major')).toThrow(
      /two different degrees/,
    );
  });
});

/** A classifier that is right for conventional homes and one degree low for manufactured ones. */
function biased(seen: { files: number; context: unknown }[]): DamageClassifier {
  return {
    classify: async (images, context) => {
      seen.push({ files: images.length, context });
      const label = images[0]!.data.toString('utf8');
      if (label === 'fail') throw new Error('provider unavailable');
      const truth = label as DamageDegree;
      const lower: Record<string, DamageDegree> = {
        destroyed: 'major',
        major: 'minor',
        minor: 'affected',
        affected: 'affected',
      };
      return {
        output: {
          degree: context.homeType === 'mobile_home' ? lower[truth]! : truth,
          confidence: 0.8,
          visibleFeatures: [],
        },
        provider: fakeProvider.info,
        latencyMs: 1,
      };
    },
  };
}

const many = (n: number, c: Omit<PhotoCase, 'id' | 'files'>, file = c.degree): PhotoCase[] =>
  Array.from({ length: n }, (_, i) => ({ ...c, id: `${c.homeTypeAnswer}-${i}`, files: [file] }));

describe('evaluatePhotos', () => {
  it('PHO-13: a group materially less accurate fails the run; the classifier is told the home type and hazard as the worker tells it', async () => {
    const seen: { files: number; context: unknown }[] = [];
    const cases = [
      ...many(60, {
        degree: 'major',
        hazard: 'flood',
        homeType: 'conventional',
        homeTypeAnswer: 'single_family',
        incomeBand: 'band 3',
      }),
      ...many(25, {
        degree: 'destroyed',
        hazard: 'tornado',
        homeType: 'manufactured',
        homeTypeAnswer: 'mobile_home',
        incomeBand: 'band 1',
      }),
    ];
    const report = await evaluatePhotos(biased(seen), 'test / biased', cases, async (file) => ({
      data: Buffer.from(file),
      mimeType: 'image/jpeg',
    }));
    expect(seen[0]).toEqual({
      files: 1,
      context: { homeType: 'single_family', hazard: 'flood' },
    });
    expect(report.cases).toBe(85);
    expect(report.exactRate).toBeCloseTo(60 / 85);
    expect(report.withinOneRate).toBe(1);
    expect(report.passed).toBe(false);
    expect(report.slices.filter((s) => s.behind).map((s) => `${s.dimension}:${s.group}`)).toEqual([
      'hazard:tornado',
      'home_type:manufactured',
      'income_band:band 1',
    ]);
    expect(report.confusion['destroyed']).toEqual({ major: 25 });
    expect(report.problems[0]).toMatch(/hazard tornado: 0% of 25 cases/);
  });

  it('a failed call counts against the model and is reported; no more than four photos go per case', async () => {
    const seen: { files: number; context: unknown }[] = [];
    const report = await evaluatePhotos(
      biased(seen),
      'test',
      [
        {
          id: 'x',
          files: ['minor', 'minor', 'minor', 'minor', 'minor'],
          degree: 'minor',
          hazard: null,
          homeType: null,
          homeTypeAnswer: null,
          incomeBand: null,
        },
        {
          id: 'y',
          files: ['fail'],
          degree: 'major',
          hazard: null,
          homeType: null,
          homeTypeAnswer: null,
          incomeBand: null,
        },
      ],
      async (file) => ({ data: Buffer.from(file), mimeType: 'image/jpeg' }),
    );
    expect(seen[0]!.files).toBe(4);
    expect(report.failed).toBe(1);
    expect(report.exactRate).toBe(0.5);
    expect(report.confusion['major']).toEqual({ failed: 1 });
    // Too few cases for any group to be called behind; unknown groups never are.
    expect(report.passed).toBe(true);
  });
});

describe('scorePhotos', () => {
  const c = (degree: PhotoCase['degree']): PhotoCase => ({
    id: degree,
    files: [],
    degree,
    hazard: 'flood',
    homeType: 'conventional',
    homeTypeAnswer: 'single_family',
    incomeBand: null,
  });
  it('AIG-08: accuracy below the baseline by more than the allowance is a regression', () => {
    const outcomes = [
      { c: c('major'), suggested: 'major' as const },
      { c: c('minor'), suggested: 'cannot_tell' as const },
    ];
    const held = scorePhotos('m', outcomes, undefined, { exactRate: 0.51 });
    expect(held.regression).toBeNull();
    expect(held.cannotTellRate).toBe(0.5);
    const fell = scorePhotos('m', outcomes, undefined, { exactRate: 0.6 });
    expect(fell.passed).toBe(false);
    expect(fell.regression).toMatch(/50% against 60%/);
  });

  it('an empty set never passes', () => {
    expect(scorePhotos('m', []).passed).toBe(false);
  });
});
