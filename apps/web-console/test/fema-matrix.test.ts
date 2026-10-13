/** The degree-reason draft carries the matrix criteria, the resident's facts and the photos (FR-12.02, DEC-02). */
import { describe, expect, it } from 'vitest';
import { draftDegreeReason, matrixColumn } from '../src/screens/fema-matrix.ts';

describe('draftDegreeReason', () => {
  it('starts with the matrix row for the chosen degree and home, lists what was reported, and leaves the check to the reviewer', () => {
    const text = draftDegreeReason({
      degree: 'major',
      column: 'conventional',
      facts: [
        { prompt: 'What is the roof like?', answer: 'Large hole' },
        { prompt: 'Can you still safely live in your home?', answer: 'No' },
      ],
      photoCount: 2,
    });
    expect(text).toContain('Major by the FEMA matrix (conventional home): Structural damage');
    expect(text).toContain('What is the roof like? Large hole.');
    expect(text).toContain('Photos on file: 2');
    expect(text.endsWith('What I checked: ')).toBe(true);
  });

  it('says so when nothing was reported and no photo exists, and handles the non-matrix choices', () => {
    const none = draftDegreeReason({
      degree: 'cannot_tell',
      column: 'manufactured',
      facts: [],
      photoCount: 0,
    });
    expect(none).toContain('Cannot tell from the record');
    expect(none).toContain('nothing about the damage itself');
    expect(none).toContain('Photos on file: none');
    expect(matrixColumn('mobile_home')).toBe('manufactured');
  });
});
