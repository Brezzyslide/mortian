import { describe, expect, it } from 'vitest';
import { inflateSync } from 'node:zlib';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { renderAgreementPdf, safe, wrap, type AgreementPdfInput } from './pdf.js';

// 1x1 transparent PNG
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

const input = (over: Partial<AgreementPdfInput> = {}): AgreementPdfInput => ({
  contractId: '00000000-0000-4000-8000-000000000001',
  reference: 'FA-000001',
  documentSha256: 'c'.repeat(64),
  text: Array.from({ length: 160 }, (_, i) => `Clause ${i + 1}. The borrower pays ₦31,384.61 every week until the total of ₦1,632,000.00 is paid.`).join('\n'),
  executedAt: new Date('2026-12-01T10:00:00Z'),
  isPlaceholder: true,
  signers: [
    { order: 1, role: 'borrower', name: 'Adébáyọ̀ Ọlọ́rùn', phone: '+234 806 *** 0001', signedAt: new Date('2026-12-01T09:00:00Z'), typedName: 'Adébáyọ̀ Ọlọ́rùn', signaturePng: PNG },
    { order: 2, role: 'guarantor', name: 'Gbenga G', phone: '+234 803 *** 0002', signedAt: new Date('2026-12-01T09:30:00Z'), typedName: 'Gbenga G', signaturePng: null },
    { order: 3, role: 'company', name: 'Company', phone: null, signedAt: new Date('2026-12-01T10:00:00Z'), typedName: 'Mary Manager', signaturePng: null },
  ],
  ...over,
});

/** Text drawn with standard fonts is stored as hex strings: decode them all to search. */
const drawnText = (bytes: Uint8Array) => {
  const raw = Buffer.from(bytes);
  const out: string[] = [];
  let at = 0;
  for (;;) {
    const start = raw.indexOf('stream', at, 'latin1');
    if (start < 0) break;
    const bodyStart = raw[start + 6] === 0x0d ? start + 8 : start + 7;
    const end = raw.indexOf('endstream', bodyStart, 'latin1');
    const body = raw.subarray(bodyStart, end);
    let content: string;
    try {
      content = inflateSync(body).toString('latin1');
    } catch {
      content = body.toString('latin1');
    }
    for (const m of content.matchAll(/<([0-9A-Fa-f]+)> Tj/g)) out.push(Buffer.from(m[1]!, 'hex').toString('latin1'));
    at = end + 9;
  }
  return out.join('\n');
};

describe('agreement PDF', () => {
  it('lays out every clause across pages, ends with a signature page, and numbers pages', async () => {
    const bytes = await renderAgreementPdf(input());
    const doc = await PDFDocument.load(bytes);
    expect(doc.getPageCount()).toBeGreaterThanOrEqual(4);
    expect(doc.getTitle()).toBe('Agreement FA-000001');
    const text = drawnText(bytes);
    expect(text).toContain('Clause 160.');
    expect(text).toContain('NGN 1,632,000.00');
    expect(text).toContain('TEST DOCUMENT - PLACEHOLDER WORDING');
    expect(text).toContain(`page ${doc.getPageCount()} of ${doc.getPageCount()}`);
    expect(text).toContain('Typed name: Mary Manager');
    expect(text).toContain('It is not a digital signature.');
    expect(text).not.toMatch(/is a (qualified )?digital signature/);
  });

  it('keeps Yoruba names readable instead of turning letters into question marks', async () => {
    const font = await (await PDFDocument.create()).embedFont(StandardFonts.Helvetica);
    expect(safe('Adébáyọ̀ Ọlọ́rùn', font)).toBe('Adébáyò Olórùn');
    expect(safe('Ṣẹgun Ị́kẹ́', font)).toBe('Segun Íké');
    expect(safe('₦500', font)).toBe('NGN 500');
    expect(safe('ok 😀', font)).toBe('ok ?');
  });

  it('is byte-for-byte repeatable for the same input', async () => {
    const a = await renderAgreementPdf(input());
    const b = await renderAgreementPdf(input());
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
  });

  it('a damaged signature image does not stop execution', async () => {
    const broken = Buffer.concat([PNG.subarray(0, 16), Buffer.from('not really a png')]);
    const bytes = await renderAgreementPdf(input({ signers: [{ ...input().signers[0]!, signaturePng: broken }] }));
    expect(drawnText(bytes)).toContain('could not be shown');
  });

  it('wraps to the line width and breaks words longer than a line', async () => {
    const font = await (await PDFDocument.create()).embedFont(StandardFonts.Helvetica);
    const lines = wrap(`short words then ${'x'.repeat(300)} end`, font, 10, 200);
    expect(lines.length).toBeGreaterThan(3);
    for (const l of lines) expect(font.widthOfTextAtSize(l, 10)).toBeLessThanOrEqual(200);
    expect(lines.join('')).toContain('x'.repeat(50));
  });
});
