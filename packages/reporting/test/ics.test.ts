/**
 * ICS forms as documents (CON-13; layer-8 plan §4 and §14): each form's
 * content model from fixed data, named with its edition and numbered
 * blocks; the PDF model and the CSV drawn from it; no resident detail
 * anywhere (plan §12); the content hash stable across equal inputs.
 */
import { describe, expect, it } from 'vitest';
import { renderPdf } from '@cg/pdf';
import { contentHash } from '../src/facts.ts';
import {
  ICS_FORMS,
  ICS_FORM_KEYS,
  ics213,
  icsCsv,
  icsPdf,
  sampleIcsForm,
} from '../src/ics/index.ts';

describe('ICS forms (CON-13)', () => {
  it('every form names its edition and numbers its blocks in order', () => {
    for (const form of ICS_FORM_KEYS) {
      const c = sampleIcsForm(form);
      expect(c.form).toBe(form);
      expect(c.edition).toBe(ICS_FORMS[form].edition);
      expect(c.number).toBe(ICS_FORMS[form].number);
      expect(c.blocks[0]).toMatchObject({
        no: '1',
        label: 'Incident name',
        value: 'WESTWIND (exercise)',
      });
      const numbers = c.blocks.map((b) => parseInt(b.no, 10));
      expect(numbers).toEqual([...numbers].sort((a, b) => a - b));
    }
  });

  it('ICS 201: objectives, actions, organization and resources are tables; the sketch is the map or a list', () => {
    const c = sampleIcsForm('ics_201');
    const block = (no: string) => c.blocks.find((b) => b.no === no)!;
    expect(block('7')).toMatchObject({
      kind: 'table',
      columns: ['No.', 'Objective', 'Owner', 'Status'],
    });
    expect(block('10').kind).toBe('table');
    expect(block('4').label).toContain('the map itself is the sketch');
    expect(block('5')).toMatchObject({ kind: 'text' });
    expect((block('5') as { text: string }).text).toContain('Situation report 3');
  });

  it('ICS 213: the approver and the reply are blocks 7 to 9; an unanswered message leaves them empty', () => {
    const c = sampleIcsForm('ics_213');
    expect(c.blocks.find((b) => b.no === '7')).toMatchObject({
      value: expect.stringContaining('Dana Whitfield (exercise), Incident Commander'),
    });
    const open = ics213({
      incident: 'X',
      timeZone: 'UTC',
      preparedBy: { name: 'A', position: null },
      preparedAt: '2026-10-15T18:00:00.000Z',
      messageNumber: 'X-GM-0002',
      to: { name: 'B', position: null },
      from: { name: 'A', position: null },
      subject: 'S',
      sentAt: null,
      body: 'Body',
      approvedBy: null,
      approvedAt: null,
      reply: null,
      repliedBy: null,
      repliedAt: null,
    });
    expect(open.blocks.find((b) => b.no === '7')).toMatchObject({ value: null });
    expect(open.blocks.find((b) => b.no === '9')).toMatchObject({ value: null });
  });

  it('ICS 213 RR: the order lines carry quantity, kind, type and description; the state number is on block 13', () => {
    const c = sampleIcsForm('ics_213rr');
    const order = c.blocks.find((b) => b.no === '4')!;
    expect(order.kind).toBe('table');
    expect((order as { rows: unknown[][] }).rows[0]).toEqual([
      '200 each',
      'Cots',
      'Standard shelter cot',
      'For the Harmon High shelter',
      null,
      null,
    ]);
    expect(c.blocks.find((b) => b.no === '13')).toMatchObject({
      value: expect.stringContaining('state number SEMA-EX-4471'),
    });
  });

  it('the CSV has one row per value and per table cell, with the edition first', () => {
    const csv = icsCsv(sampleIcsForm('ics_309'));
    const lines = csv.split('\r\n');
    expect(lines[0]).toBe('\ufeffBlock,Label,Row,Column,Value');
    expect(lines[1]).toContain('ICS 309');
    expect(lines[1]).toContain('FEMA 2018 edition');
    expect(csv).toContain('4,Log,2,From,NET');
    expect(csv).toContain('4,Log,2,To,TC-1');
  });

  it('the PDF model names the form, the edition and the hash; preview says so when not issued', async () => {
    const c = sampleIcsForm('ics_214');
    const issued = icsPdf(c, {
      productName: 'Test Product',
      contentHash: 'a'.repeat(64),
      sequence: 2,
    });
    expect(issued.title).toBe('ICS 214 Activity Log: WESTWIND (exercise)');
    expect(issued.producer).toBe('Test Product');
    expect(JSON.stringify(issued.blocks)).toContain('a'.repeat(64));
    expect(issued.footer).toContain('issue 2');
    const preview = icsPdf(c, { productName: 'Test Product' });
    expect(JSON.stringify(preview.blocks)).toContain('Preview: not issued');
    const pdf = await renderPdf(issued);
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
  });

  it('plan §12: no form carries a resident; only staff names, positions and counts', () => {
    for (const form of ICS_FORM_KEYS) {
      const text = JSON.stringify(sampleIcsForm(form));
      expect(text).not.toMatch(/@example\.org|\(\d{3}\) \d{3}-\d{4}|resident:/i);
    }
  });

  it('the content hash is stable for equal content and changes with it', () => {
    const a = sampleIcsForm('ics_201');
    const b = sampleIcsForm('ics_201');
    expect(contentHash(a)).toBe(contentHash(b));
    expect(contentHash({ ...a, incident: 'Other' })).not.toBe(contentHash(a));
  });
});
