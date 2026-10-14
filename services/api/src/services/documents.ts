// PDF documents: L2-6 invoice and per-milestone receipt, L3-3 signed proof of funds, L4-7 signed
// trade record. Signed documents carry an Ed25519 signature over their canonical facts; anyone can
// check them at the public verification page.
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from 'pdf-lib';
import type { Ctx } from '../ctx.ts';
import { maybe, one, type Queryable } from '../db/pool.ts';
import { randomToken } from '../lib/crypto.ts';

export type DocKind = 'invoice' | 'receipt' | 'proof_of_funds' | 'trade_record';

const TITLES: Record<DocKind, string> = {
  invoice: 'Invoice',
  receipt: 'Payment receipt',
  proof_of_funds: 'Proof of funds held in escrow',
  trade_record: 'Signed P2P trade record',
};

/** Signs and stores a document's facts once (idempotent per kind and subject). */
export async function signDocument(ctx: Ctx, q: Queryable, kind: DocKind, subjectId: string, facts: Record<string, unknown>): Promise<{ code: string; canonical: string; signature: string; publicKey: string }> {
  const ex = await maybe<{ verify_code: string; canonical: string; signature: string; public_key: string }>(q, 'SELECT * FROM app.documents WHERE kind = $1 AND subject_id = $2', [kind, subjectId]);
  if (ex) return { code: ex.verify_code, canonical: ex.canonical, signature: ex.signature, publicKey: ex.public_key };
  const doc = { kind, subjectId, issuer: 'Backstop', issuedAt: ctx.now().toISOString(), ...facts };
  const s = ctx.crypto.signDocument(doc);
  const code = randomToken(10);
  await one(q, 'INSERT INTO app.documents (kind, subject_id, canonical, signature, public_key, verify_code) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id', [kind, subjectId, s.canonical, s.signature, s.publicKey, code]);
  return { code, ...s };
}

function wrap(text: string, font: PDFFont, size: number, width: number): string[] {
  const out: string[] = [];
  for (const para of text.split('\n')) {
    let line = '';
    for (const word of para.split(/\s+/)) {
      const next = line ? `${line} ${word}` : word;
      if (font.widthOfTextAtSize(next, size) > width && line) {
        out.push(line);
        line = word;
      } else line = next;
    }
    out.push(line);
  }
  return out;
}

/** WinAnsi-safe text for the standard fonts (₦ is not in WinAnsi). */
function safe(s: string): string {
  return s.replace(/₦/g, 'NGN ').replace(/[^\x20-\x7E\n]/g, '?');
}

export async function renderPdf(ctx: Ctx, kind: DocKind, rows: Array<[string, string]>, opts: { intro?: string; signed?: { code: string; signature: string; publicKey: string }; footer?: string } = {}): Promise<Buffer> {
  const pdf = await PDFDocument.create();
  pdf.setTitle(`Backstop ${TITLES[kind]}`);
  pdf.setProducer('Backstop');
  pdf.setCreationDate(ctx.now());
  if (opts.signed) pdf.setKeywords([`backstop-verify:${opts.signed.code}`, `ed25519:${opts.signed.signature}`]);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  let page: PDFPage = pdf.addPage([595, 842]);
  let y = 790;
  const left = 50;
  const width = 495;
  const line = (text: string, f = font, size = 10, color = rgb(0.1, 0.1, 0.1)) => {
    for (const l of wrap(safe(text), f, size, width)) {
      if (y < 60) {
        page = pdf.addPage([595, 842]);
        y = 790;
      }
      page.drawText(l, { x: left, y, size, font: f, color });
      y -= size + 5;
    }
  };
  line('Backstop', bold, 20);
  line(TITLES[kind], bold, 14);
  y -= 6;
  if (opts.intro) {
    line(opts.intro);
    y -= 6;
  }
  for (const [k, v] of rows) {
    line(k, bold, 9, rgb(0.35, 0.35, 0.35));
    line(v || '-', font, 11);
    y -= 3;
  }
  if (opts.signed) {
    y -= 10;
    line('Verification', bold, 12);
    line(`Check this document at ${ctx.cfg.webBaseUrl}/verify/${opts.signed.code}`);
    line(`Ed25519 signature: ${opts.signed.signature}`, font, 7);
    line(`Backstop public key: ${opts.signed.publicKey}`, font, 7);
  }
  if (opts.footer) {
    y -= 10;
    line(opts.footer, font, 8, rgb(0.4, 0.4, 0.4));
  }
  return Buffer.from(await pdf.save());
}
