/**
 * FL-15, BRD:FR-18.03: a job aid is written as plain text and stored as a
 * small, escaped HTML that the field app reads as text again. Nothing typed
 * becomes markup, and the stored form reads back as what was written.
 */
import { describe, expect, it } from 'vitest';
import { jobAidHtml, jobAidText } from '../src/job-aid-text.ts';

describe('job aid text (FL-15)', () => {
  it('headings, lists and paragraphs become the fixed HTML, and read back as written', () => {
    const text = [
      '## Before you go in',
      '- Check for downed lines',
      '- Smell for gas',
      '',
      'If in doubt, stay out and call it in.',
      'Tell your team lead.',
    ].join('\n');
    const html = jobAidHtml(text);
    expect(html).toBe(
      '<h2>Before you go in</h2><ul><li>Check for downed lines</li><li>Smell for gas</li></ul><p>If in doubt, stay out and call it in. Tell your team lead.</p>',
    );
    expect(jobAidText(html)).toBe(
      '## Before you go in\n\n- Check for downed lines\n- Smell for gas\n\nIf in doubt, stay out and call it in. Tell your team lead.',
    );
    expect(jobAidHtml(jobAidText(html))).toBe(html);
  });

  it('nothing typed becomes markup', () => {
    const html = jobAidHtml('<script>alert(1)</script>\n- <img src=x onerror=alert(1)>');
    expect(html).not.toMatch(/<script|<img/);
    expect(html).toContain('&lt;script&gt;');
    expect(jobAidText(html)).toContain('<script>alert(1)</script>');
  });

  it('reads the seeded exercise aids (their HTML) as text for editing', () => {
    const seeded =
      '<h2>Pick from pictures</h2><ul><li><strong>Minor:</strong> repairable damage.</li></ul><p>Never from words alone.</p>';
    expect(jobAidText(seeded)).toBe(
      '## Pick from pictures\n\n- Minor: repairable damage.\n\nNever from words alone.',
    );
  });
});
