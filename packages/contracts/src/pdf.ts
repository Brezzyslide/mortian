import { readFileSync } from 'node:fs';
import fontkit from '@pdf-lib/fontkit';
import { PDFDocument, rgb, type PDFFont, type PDFPage } from 'pdf-lib';

// Noto Sans (SIL Open Font License, fonts/OFL.txt): covers Yoruba, Igbo and Hausa letters and ₦.
let fontBytes: { regular: Uint8Array; bold: Uint8Array } | null = null;
function fonts() {
  fontBytes ??= {
    regular: readFileSync(new URL('../fonts/NotoSans-Regular.ttf', import.meta.url)),
    bold: readFileSync(new URL('../fonts/NotoSans-Bold.ttf', import.meta.url)),
  };
  return fontBytes;
}

/** Embeds the agreement fonts into a document. */
export async function embedAgreementFonts(pdf: PDFDocument) {
  pdf.registerFontkit(fontkit);
  return {
    font: await pdf.embedFont(fonts().regular, { subset: false }),
    bold: await pdf.embedFont(fonts().bold, { subset: false }),
  };
}

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
  const { font, bold } = await embedAgreementFonts(pdf);
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
  for (const l of wrap('This PDF is a readable copy. The signed original is the archived text file with the fingerprint above.', font, 9, width)) line(l, font, 9);

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
 * Keeps every character the embedded font can draw. Anything it cannot (emoji, rare scripts)
 * keeps its base letter and drawable accents if it has them, otherwise becomes '?'. The archived
 * text file always keeps the exact characters.
 */
export function safe(text: string, font: PDFFont): string {
  const set = charSets.get(font) ?? new Set(font.getCharacterSet());
  charSets.set(font, set);
  const ok = (str: string) => [...str].every((c) => set.has(c.codePointAt(0)!));
  let out = '';
  const clean = text.normalize('NFC').replace(/\t/g, '    ');
  for (const { segment: g } of new Intl.Segmenter('en', { granularity: 'grapheme' }).segment(clean)) {
    if (ok(g)) {
      out += g;
      continue;
    }
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
const charSets = new WeakMap<PDFFont, Set<number>>();

/** Width of a string at size 1, cached per font: shaping through fontkit is the slow part. */
const widths = new WeakMap<PDFFont, Map<string, number>>();
function measure(font: PDFFont, text: string, size: number): number {
  let m = widths.get(font);
  if (!m) widths.set(font, (m = new Map()));
  let w = m.get(text);
  if (w === undefined) m.set(text, (w = font.widthOfTextAtSize(text, 1)));
  return w * size;
}

/**
 * Greedy word wrap. Line width is the sum of cached word widths plus spaces, with a small margin
 * for kerning across word boundaries.
 */
export function wrap(text: string, font: PDFFont, size: number, width: number): string[] {
  const limit = width - size * 0.25;
  const space = measure(font, ' ', size);
  const out: string[] = [];
  let cur = '';
  let curW = 0;
  for (const word of text.split(/ +/)) {
    const w = measure(font, word, size);
    if (cur && curW + space + w <= limit) {
      cur += ` ${word}`;
      curW += space + w;
      continue;
    }
    if (!cur && w <= limit) {
      cur = word;
      curW = w;
      continue;
    }
    if (cur) out.push(cur);
    // A single word wider than the line (a long hash or URL) is broken by characters.
    let rest = word;
    while (measure(font, rest, size) > limit) {
      let n = 1;
      let acc = 0;
      const chars = [...rest];
      while (n < chars.length && acc + measure(font, chars[n - 1]!, size) <= limit) acc += measure(font, chars[n++ - 1]!, size);
      const head = chars.slice(0, Math.max(1, n - 1)).join('');
      out.push(head);
      rest = rest.slice(head.length);
    }
    cur = rest;
    curW = measure(font, rest, size);
  }
  if (cur) out.push(cur);
  return out;
}
