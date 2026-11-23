import { describe, expect, it } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { embedAgreementFonts, renderAgreementPdf, safe, wrap, type AgreementPdfInput } from './pdf.js';

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

/** Text as a PDF reader extracts it (pdf.js), one string per page joined. */
async function drawnText(bytes: Uint8Array): Promise<string> {
  const doc = await getDocument({ data: new Uint8Array(bytes), useSystemFonts: false, isEvalSupported: false }).promise;
  const pages: string[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const c = await (await doc.getPage(i)).getTextContent();
    pages.push(c.items.map((it) => ('str' in it ? it.str : '')).join('\n'));
  }
  return pages.join('\n');
}

describe('agreement PDF', { timeout: 30_000 }, () => {
  it('lays out every clause across pages, ends with a signature page, and numbers pages', async () => {
    const bytes = await renderAgreementPdf(input());
    const doc = await PDFDocument.load(bytes);
    expect(doc.getPageCount()).toBeGreaterThanOrEqual(4);
    expect(doc.getTitle()).toBe('Agreement FA-000001');
    const text = await drawnText(bytes);
    expect(text).toContain('Clause 160.');
    expect(text).toContain('₦1,632,000.00');
    expect(text).toContain('TEST DOCUMENT - PLACEHOLDER WORDING');
    expect(text).toContain(`page ${doc.getPageCount()} of ${doc.getPageCount()}`);
    expect(text).toContain('Typed name: Mary Manager');
    expect(text).toContain('It is not a digital signature.');
    expect(text).not.toMatch(/is a (qualified )?digital signature/);
  });

  it('keeps Yoruba and Igbo letters exactly; only characters the font lacks are replaced', async () => {
    const { font } = await embedAgreementFonts(await PDFDocument.create());
    expect(safe('Adébáyọ̀ Ọlọ́rùn', font)).toBe('Adébáyọ̀ Ọlọ́rùn'.normalize('NFC'));
    expect(safe('Ṣẹgun Ị́kẹ́ Ụ̀zọ̀', font)).toBe('Ṣẹgun Ị́kẹ́ Ụ̀zọ̀'.normalize('NFC'));
    expect(safe('₦500', font)).toBe('₦500');
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
    expect(await drawnText(bytes)).toContain('could not be shown');
  });

  it('wraps to the line width and breaks words longer than a line', async () => {
    const { font } = await embedAgreementFonts(await PDFDocument.create());
    const lines = wrap(`short words then ${'x'.repeat(300)} end`, font, 10, 200);
    expect(lines.length).toBeGreaterThan(3);
    for (const l of lines) expect(font.widthOfTextAtSize(l, 10)).toBeLessThanOrEqual(200);
    expect(lines.join('')).toContain('x'.repeat(50));
  });
});
