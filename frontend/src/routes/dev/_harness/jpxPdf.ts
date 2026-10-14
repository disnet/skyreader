// A one-page PDF holding a JPEG 2000 (JPX) image, built in memory for the PDF
// viewer harness. PDF.js decodes JPX with its OpenJPEG module, which it loads
// from `wasmUrl` (or that module's JS fallback, from the same place): a page
// that shows the image proves the decoders are served and found.

/** A 160×100 JPEG 2000 image (a gradient band over a red block), base64. */
export const SAMPLE_JPX_BASE64 =
  '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';

export function makeJpxPdf(jpx: Uint8Array, width: number, height: number): Uint8Array {
  const enc = new TextEncoder();
  const parts: Uint8Array[] = [];
  const offsets: number[] = [];
  let length = 0;
  const push = (chunk: string | Uint8Array) => {
    const bytes = typeof chunk === 'string' ? enc.encode(chunk) : chunk;
    parts.push(bytes);
    length += bytes.length;
  };
  const obj = (n: number, body: (string | Uint8Array)[]) => {
    offsets[n - 1] = length;
    push(`${n} 0 obj\n`);
    for (const piece of body) push(piece);
    push('\nendobj\n');
  };
  const draw =
    `q ${width * 2} 0 0 ${height * 2} 72 480 cm /Im1 Do Q\n` +
    'BT /F1 14 Tf 72 450 Td (A JPEG 2000 image, drawn by OpenJPEG) Tj ET';

  push('%PDF-1.5\n');
  obj(1, ['<< /Type /Catalog /Pages 2 0 R >>']);
  obj(2, ['<< /Type /Pages /Kids [3 0 R] /Count 1 >>']);
  obj(3, [
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R ' +
      '/Resources << /XObject << /Im1 5 0 R >> /Font << /F1 6 0 R >> >> >>',
  ]);
  obj(4, [`<< /Length ${draw.length} >>\nstream\n${draw}\nendstream`]);
  obj(5, [
    `<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} ` +
      `/Filter /JPXDecode /Length ${jpx.length} >>\nstream\n`,
    jpx,
    '\nendstream',
  ]);
  obj(6, ['<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>']);
  const xref = length;
  push('xref\n0 7\n0000000000 65535 f \n');
  for (const o of offsets) push(`${String(o).padStart(10, '0')} 00000 n \n`);
  push(`trailer\n<< /Size 7 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);

  const out = new Uint8Array(length);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}
