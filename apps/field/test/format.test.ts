/** FL-01: the code a worker scans from a resident's confirmation, or types. */
import { describe, expect, it } from 'vitest';
import { codeFrom } from '../src/format.ts';

describe('codeFrom', () => {
  it("reads the code from the confirmation's QR link, or takes what was typed", () => {
    expect(codeFrom('https://help.example.org/county/my-report?ref=KXRT-4827')).toBe('KXRT-4827');
    expect(codeFrom('  kxrt 4827 ')).toBe('kxrt 4827');
    expect(codeFrom('https://help.example.org/county/my-report')).toBe(
      'https://help.example.org/county/my-report',
    );
  });
});
