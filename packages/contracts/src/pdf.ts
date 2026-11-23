import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from 'pdf-lib';

export interface PdfSigner {
  order: number;
  role: string;
  name: string;
  phone: string | null;
  signedAt: Date;
  typedName: string;
  signaturePng: Buffer | null;
}

export interface AgreementPdfInput {
  contractId: string;
  reference: string;
  documentSha256: string;
  text: string;
  executedAt: Date;
  isPlaceholder: boolean;
  signers: PdfSigner[];
}

const A4: [number, number] = [595.28, 841.89];
const MARGIN = 56;
const BODY = 10.5;
const LEAD = 14.5;

/**
 * The executed agreement as a PDF: the exact issued text, then a signature page. Rendering is
 * deterministic for the same input (fixed metadata dates), so a retried execution produces the
 * same bytes. The archived text file stays the authoritative copy whose hash every signer saw.
 */
export async function renderAgreementPdf(input: AgreementPdfInput): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  pdf.setTitle(`Agreement ${input.reference}`);
  pdf.setSubject(`Contract ${input.contractId}`);
  pdf.setProducer('contracts');
  pdf.setCreator('contracts');
  pdf.setCreationDate(input.executedAt);
  pdf.setModificationDate(input.executedAt);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const width = A4[0] - MARGIN * 2;

  let page = pdf.addPage(A4);
  let y = A4[1] - MARGIN;
  const newPage = () => {
    page = pdf.addPage(A4);
    y = A4[1] - MARGIN;
  };
  const line = (text: string, f: PDFFont = font, size = BODY) => {
    if (y < MARGIN + 30) newPage();
    page.drawText(text, { x: MARGIN, y, size, font: f });
    y -= size === BODY ? LEAD : size * 1.4;
  };

  if (input.isPlaceholder) {
    line('TEST DOCUMENT - PLACEHOLDER WORDING, NOT REVIEWED BY A LAWYER', bold);
    y -= 6;
  }
  for (const para of input.text.split('\n')) {
    if (para.trim() === '') {
      y -= LEAD / 2;
      continue;
    }
    for (const l of wrap(safe(para, font), font, BODY, width)) line(l);
  }

  // Signature page
  newPage();
  line('Signatures', bold, 14);
  y -= 4;
  for (const l of wrap(
    `Each person below confirmed their phone number with a one-time SMS code, read the agreement, ticked each key term and confirmed they intended to sign. Full evidence is in the execution certificate for contract ${input.contractId}.`,
    font,
    BODY,
    width,
  ))
    line(l);
  y -= 10;
  for (const s of input.signers) {
    if (y < MARGIN + 150) newPage();
    line(`${s.order}. ${roleLabel(s.role)}: ${safe(s.name, bold)}`, bold, 11);
    line(`Signed ${s.signedAt.toISOString().replace('T', ' ').slice(0, 19)} UTC${s.phone ? ` - phone ${safe(s.phone, font)}` : ''}`);
    line(`Typed name: ${safe(s.typedName || '-', font)}`);
    const drawn = s.signaturePng ? await drawSignature(pdf, page, s.signaturePng, MARGIN, y - 70) : false;
    if (s.signaturePng && !drawn) line('(A drawn signature was given but could not be shown; its hash is in the certificate.)');
    if (drawn) y -= 78;
    page.drawLine({ start: { x: MARGIN, y: y + 2 }, end: { x: MARGIN + width, y: y + 2 }, thickness: 0.5, color: rgb(0.8, 0.8, 0.8) });
    y -= 14;
  }
  y -= 6;
  for (const l of wrap(
    `Document fingerprint (SHA-256 of the agreement text): ${input.documentSha256}. This fingerprint is tamper evidence: it shows the text has not changed since it was issued. It is not a digital signature.`,
    font,
    9,
    width,
  ))
    line(l, font, 9);
  y -= 4;
  for (const l of wrap(
    'This PDF is a readable copy. Some letters may be simplified (for example o for the Yoruba letter with a dot below). The signed original is the archived text file with the fingerprint above.',
    font,
    9,
    width,
  ))
    line(l, font, 9);

  const pages = pdf.getPages();
  pages.forEach((p, i) => {
    p.drawText(`${input.reference} - contract ${input.contractId} - page ${i + 1} of ${pages.length} - document SHA-256 ${input.documentSha256.slice(0, 16)}...`, {
      x: MARGIN,
      y: MARGIN / 2,
      size: 7.5,
      font,
      color: rgb(0.4, 0.4, 0.4),
    });
  });
  return pdf.save({ useObjectStreams: false });
}

async function drawSignature(pdf: PDFDocument, page: PDFPage, png: Buffer, x: number, y: number): Promise<boolean> {
  try {
    const img = await pdf.embedPng(png);
    const scale = Math.min(220 / img.width, 64 / img.height, 1);
    page.drawImage(img, { x, y, width: img.width * scale, height: img.height * scale });
    return true;
  } catch {
    return false; // a damaged image must never block execution
  }
}

function roleLabel(role: string) {
  return role === 'company' ? 'For the company' : role.charAt(0).toUpperCase() + role.slice(1);
}

/**
 * Standard PDF fonts cover WinAnsi only. The naira sign becomes "NGN"; letters the font lacks
 * (Yoruba ọ ẹ ṣ, Igbo ị ụ) fold to their base letter so names stay readable; anything else
 * becomes '?'. The archived text file keeps the exact characters.
 */
export function safe(text: string, font: PDFFont): string {
  const ok = (ch: string) => {
    try {
      font.encodeText(ch);
      return true;
    } catch {
      return false;
    }
  };
  let out = '';
  const clean = text.normalize('NFC').replace(/₦/g, 'NGN ').replace(/\t/g, '    ');
  for (const { segment: g } of new Intl.Segmenter('en', { granularity: 'grapheme' }).segment(clean)) {
    if (ok(g)) {
      out += g;
      continue;
    }
    // Keep the base letter and whichever accents the font can draw (ọ́ -> ó), drop the rest.
    const [base = '', ...marks] = [...g.normalize('NFD')];
    if (!ok(base)) {
      out += '?';
      continue;
    }
    let folded = base;
    for (const m of marks) {
      const t = (folded + m).normalize('NFC');
      if (ok(t)) folded = t;
    }
    out += folded;
  }
  return out;
}

export function wrap(text: string, font: PDFFont, size: number, width: number): string[] {
  const out: string[] = [];
  let cur = '';
  for (const word of text.split(/ +/)) {
    const next = cur ? `${cur} ${word}` : word;
    if (font.widthOfTextAtSize(next, size) <= width) {
      cur = next;
      continue;
    }
    if (cur) out.push(cur);
    // A single word wider than the line (a long hash or URL) is broken by characters.
    let w = word;
    while (font.widthOfTextAtSize(w, size) > width) {
      let n = w.length - 1;
      while (n > 1 && font.widthOfTextAtSize(w.slice(0, n), size) > width) n--;
      out.push(w.slice(0, n));
      w = w.slice(n);
    }
    cur = w;
  }
  if (cur) out.push(cur);
  return out;
}
