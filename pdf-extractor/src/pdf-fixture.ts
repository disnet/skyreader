// Test-only: builds small PDFs in memory so tests need no binary fixtures.

// A text line placed on a page: [x, y, size, text].
export type Placed = [number, number, number, string];

// A minimal, valid PDF: Helvetica text at fixed positions, one content stream
// per page, an Info dictionary. Enough geometry to exercise the line/paragraph
// inference without checking a binary fixture into the repo.
export function makePdf(pages: Placed[][], info: Record<string, string> = {}): Uint8Array {
  const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
  const objects: string[] = [];
  const add = (body: string) => objects.push(body); // the new length is the 1-based object number

  const catalog = add(''); // filled once the page tree number is known
  const pagesObj = add('');
  const font = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  const kids: number[] = [];
  for (const lines of pages) {
    const stream = lines
      .map(([x, y, size, text]) => `BT /F1 ${size} Tf ${x} ${y} Td (${esc(text)}) Tj ET`)
      .join('\n');
    const content = add(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
    kids.push(
      add(
        `<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 612 792] /Contents ${content} 0 R /Resources << /Font << /F1 ${font} 0 R >> >> >>`
      )
    );
  }
  objects[catalog - 1] = `<< /Type /Catalog /Pages ${pagesObj} 0 R >>`;
  objects[pagesObj - 1] =
    `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`;
  const infoObj = add(
    `<< ${Object.entries(info)
      .map(([k, v]) => `/${k} (${esc(v)})`)
      .join(' ')} >>`
  );

  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) out += `${String(o).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R /Info ${infoObj} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(out);
}
