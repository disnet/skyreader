// Builds small EPUBs (zips) in memory for tests of services/epub.ts and the
// upload route. Entries are deflated unless named in `stored`; `mimetype` is
// always stored first, as OCF requires.

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const b of bytes) crc = CRC_TABLE[(crc ^ b) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

async function deflate(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function buildZip(
  files: [name: string, content: string | Uint8Array][],
  opts: { stored?: string[] } = {}
): Promise<Uint8Array> {
  const enc = new TextEncoder();
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  for (const [name, content] of files) {
    const raw = typeof content === 'string' ? enc.encode(content) : content;
    const store = name === 'mimetype' || opts.stored?.includes(name);
    const data = store ? raw : await deflate(raw);
    const nameBytes = enc.encode(name);
    const crc = crc32(raw);

    const local = new Uint8Array(30 + nameBytes.length + data.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(6, 0x0800, true);
    lv.setUint16(8, store ? 0 : 8, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, data.length, true);
    lv.setUint32(22, raw.length, true);
    lv.setUint16(26, nameBytes.length, true);
    local.set(nameBytes, 30);
    local.set(data, 30 + nameBytes.length);

    const central = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0x0800, true);
    cv.setUint16(10, store ? 0 : 8, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, data.length, true);
    cv.setUint32(24, raw.length, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint32(42, offset, true);
    central.set(nameBytes, 46);

    locals.push(local);
    centrals.push(central);
    offset += local.length;
  }
  const cdSize = centrals.reduce((n, c) => n + c.length, 0);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, files.length, true);
  ev.setUint16(10, files.length, true);
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, offset, true);

  const out = new Uint8Array(offset + cdSize + 22);
  let o = 0;
  for (const part of [...locals, ...centrals, eocd]) {
    out.set(part, o);
    o += part.length;
  }
  return out;
}

export interface FixtureChapter {
  id: string;
  body: string;
  linear?: boolean;
  nav?: boolean;
}

/** A minimal EPUB 3 with the given chapters (XHTML body markup), in spine order. */
export async function buildEpub(
  opts: {
    title?: string;
    creators?: string[];
    date?: string;
    description?: string;
    chapters?: FixtureChapter[];
    extra?: [string, string | Uint8Array][];
    /** An EPUB 2 NCX, stored at OEBPS/toc.ncx and named on the spine. */
    ncx?: string;
    /** More `<item>` elements for the manifest, verbatim. */
    manifest?: string[];
    /** More metadata markup (an EPUB 2 `<meta name="cover">`), verbatim. */
    metadata?: string;
  } = {}
): Promise<Uint8Array> {
  const chapters = opts.chapters ?? [
    { id: 'ch1', body: '<h1>Chapter One</h1><p>It was a bright cold day in April.</p>' },
  ];
  const meta = [
    opts.title !== undefined ? `<dc:title>${opts.title}</dc:title>` : '',
    ...(opts.creators ?? []).map((c) => `<dc:creator>${c}</dc:creator>`),
    opts.date ? `<dc:date>${opts.date}</dc:date>` : '',
    opts.description ? `<dc:description>${opts.description}</dc:description>` : '',
    opts.metadata ?? '',
  ].join('\n');
  const opf = `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="id">urn:uuid:test</dc:identifier>
    ${meta}
  </metadata>
  <manifest>
    ${chapters
      .map(
        (c) =>
          `<item id="${c.id}" href="text/${c.id}.xhtml" media-type="application/xhtml+xml"${c.nav ? ' properties="nav"' : ''}/>`
      )
      .join('\n    ')}
    ${(opts.manifest ?? []).join('\n    ')}
    ${opts.ncx ? '<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>' : ''}
  </manifest>
  <spine${opts.ncx ? ' toc="ncx"' : ''}>
    ${chapters
      .map((c) => `<itemref idref="${c.id}"${c.linear === false ? ' linear="no"' : ''}/>`)
      .join('\n    ')}
  </spine>
</package>`;
  return buildZip([
    ['mimetype', 'application/epub+zip'],
    [
      'META-INF/container.xml',
      `<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`,
    ],
    ['OEBPS/content.opf', opf],
    ...chapters.map(
      (c) =>
        [
          `OEBPS/text/${c.id}.xhtml`,
          `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head><title>${c.id}</title><link rel="stylesheet" href="../style.css"/></head>
<body>${c.body}</body>
</html>`,
        ] as [string, string]
    ),
    ...(opts.ncx ? [['OEBPS/toc.ncx', opts.ncx] as [string, string]] : []),
    ...(opts.extra ?? []),
  ]);
}
