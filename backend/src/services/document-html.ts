import { escapeHtml } from '../utils/html-text';

/**
 * A standard.site document's body as plain HTML, for readers outside the web app
 * (the Google Reader API, routes/greader.ts). The web app renders documents with
 * its own, much richer renderer (frontend leaflet-renderer.ts); this one covers
 * the blocks prose is made of — text, headings, quotes, code, lists, images and
 * links — with bold, italic, code, strikethrough and link formatting, and leaves
 * the rest to the link back to the publication.
 *
 * Leaflet (`pub.leaflet.content`) is read block by block. Any other format gets
 * the record's `textContent` as paragraphs, or failing that the top-level text
 * blocks of a format that spells its text `plaintext` (pckt, offprint). Every
 * string is escaped.
 */

interface Facet {
  index?: { byteStart?: number; byteEnd?: number };
  features?: Array<{ $type?: string; uri?: string }>;
}

interface Block {
  $type?: string;
  plaintext?: string;
  facets?: Facet[];
  level?: number;
  children?: ListItem[];
  startIndex?: number;
  image?: { ref?: { $link?: string } };
  alt?: string;
  src?: string;
  title?: string;
  description?: string;
}

interface ListItem {
  content?: Block;
  children?: ListItem[];
}

interface DocumentRecord {
  content?: unknown;
  textContent?: string;
  description?: string;
}

const MAX_DEPTH = 8;

function safeHref(uri: string | undefined): string | null {
  if (!uri) return null;
  try {
    const url = new URL(uri);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
  } catch {
    return null;
  }
}

/** Plaintext with its facets applied. Facet offsets are UTF-8 byte offsets. */
function richText(plaintext: string, facets: Facet[] | undefined): string {
  if (!facets?.length) return escapeHtml(plaintext);
  const bytes = new TextEncoder().encode(plaintext);
  const decoder = new TextDecoder();
  const valid = facets.filter(
    (f) =>
      Number.isInteger(f.index?.byteStart) &&
      Number.isInteger(f.index?.byteEnd) &&
      f.index!.byteStart! >= 0 &&
      f.index!.byteStart! < f.index!.byteEnd! &&
      f.index!.byteEnd! <= bytes.length
  );
  // Cut at every facet edge and wrap each piece in the facets covering it, so
  // overlapping facets still nest properly.
  const cuts = [
    ...new Set([
      0,
      bytes.length,
      ...valid.flatMap((f) => [f.index!.byteStart!, f.index!.byteEnd!]),
    ]),
  ].sort((a, b) => a - b);
  let html = '';
  for (let i = 0; i < cuts.length - 1; i++) {
    const [start, end] = [cuts[i], cuts[i + 1]];
    let piece = escapeHtml(decoder.decode(bytes.slice(start, end)));
    for (const facet of valid) {
      if (facet.index!.byteStart! > start || facet.index!.byteEnd! < end) continue;
      for (const feature of facet.features ?? []) {
        const kind = feature.$type?.split('#')[1];
        if (kind === 'bold') piece = `<strong>${piece}</strong>`;
        else if (kind === 'italic') piece = `<em>${piece}</em>`;
        else if (kind === 'code') piece = `<code>${piece}</code>`;
        else if (kind === 'strikethrough') piece = `<s>${piece}</s>`;
        else if (kind === 'link') {
          const href = safeHref(feature.uri);
          if (href) piece = `<a href="${escapeHtml(href)}">${piece}</a>`;
        }
      }
    }
    html += piece;
  }
  return html;
}

export function documentBlobUrl(authorDid: string, cid: string): string {
  return `https://cdn.bsky.app/img/feed_fullsize/plain/${authorDid}/${cid}@jpeg`;
}

function renderList(items: ListItem[] | undefined, ordered: boolean, depth: number): string {
  if (!Array.isArray(items) || depth > MAX_DEPTH) return '';
  const tag = ordered ? 'ol' : 'ul';
  const lis = items.map((item) => {
    const text = item.content?.plaintext
      ? richText(item.content.plaintext, item.content.facets)
      : '';
    return `<li>${text}${renderList(item.children, ordered, depth + 1)}</li>`;
  });
  return `<${tag}>${lis.join('')}</${tag}>`;
}

function renderBlock(block: Block, authorDid: string, depth: number): string {
  const text = () => richText(block.plaintext ?? '', block.facets);
  switch (block.$type) {
    case 'pub.leaflet.blocks.text':
      return block.plaintext ? `<p>${text()}</p>` : '';
    case 'pub.leaflet.blocks.header': {
      const level = Math.min(Math.max(Math.trunc(Number(block.level) || 2), 1), 6);
      return `<h${level}>${text()}</h${level}>`;
    }
    case 'pub.leaflet.blocks.blockquote':
      return `<blockquote><p>${text()}</p></blockquote>`;
    case 'pub.leaflet.blocks.code':
      return `<pre><code>${escapeHtml(block.plaintext ?? '')}</code></pre>`;
    case 'pub.leaflet.blocks.horizontalRule':
      return '<hr>';
    case 'pub.leaflet.blocks.unorderedList':
      return renderList(block.children, false, depth);
    case 'pub.leaflet.blocks.orderedList':
      return renderList(block.children, true, depth);
    case 'pub.leaflet.blocks.image': {
      const cid = block.image?.ref?.$link;
      return cid && /^[a-z0-9]+$/i.test(cid)
        ? `<p><img src="${documentBlobUrl(authorDid, cid)}" alt="${escapeHtml(block.alt ?? '')}"></p>`
        : '';
    }
    case 'pub.leaflet.blocks.website': {
      const href = safeHref(block.src);
      return href
        ? `<p><a href="${escapeHtml(href)}">${escapeHtml(block.title || href)}</a></p>`
        : '';
    }
    default:
      // Another format's text block, or a Leaflet block this doesn't draw.
      return block.plaintext ? `<p>${text()}</p>` : '';
  }
}

function leafletHtml(content: unknown, authorDid: string): string {
  const pages = (content as { pages?: Array<{ blocks?: Array<{ block?: Block }> }> }).pages;
  if (!Array.isArray(pages)) return '';
  // Only the first page: Leaflet also lists sub-pages here, referenced from the
  // first, and the reader can open those on the publication.
  const blocks = pages[0]?.blocks;
  if (!Array.isArray(blocks)) return '';
  const parts: string[] = [];
  for (const wrapper of blocks) {
    const block = wrapper?.block;
    if (!block || typeof block !== 'object') continue;
    if (block.$type === 'pub.leaflet.blocks.membersOnlyDelimiter') break;
    const html = renderBlock(block, authorDid, 0);
    if (html) parts.push(html);
  }
  return parts.join('\n');
}

/** Text blocks of a flat-items format (pckt, offprint), as paragraphs. */
function itemsHtml(content: unknown): string {
  const items = (content as { items?: unknown }).items;
  if (!Array.isArray(items)) return '';
  return items
    .map((item) => {
      const block = item as Block;
      return block?.plaintext ? `<p>${richText(block.plaintext, block.facets)}</p>` : '';
    })
    .filter(Boolean)
    .join('\n');
}

function paragraphs(text: string): string {
  return text
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => `<p>${escapeHtml(p).replace(/\n/g, '<br>')}</p>`)
    .join('\n');
}

export function documentHtml(record: DocumentRecord, authorDid: string): string {
  const content = record.content;
  const isLeaflet =
    !!content &&
    typeof content === 'object' &&
    (content as { $type?: string }).$type === 'pub.leaflet.content';
  const html = isLeaflet ? leafletHtml(content, authorDid) : '';
  if (html) return html;
  // Other formats nest text this doesn't walk, so their full text wins over
  // the top-level paragraphs itemsHtml can find.
  if (record.textContent) return paragraphs(record.textContent);
  const items = content && typeof content === 'object' ? itemsHtml(content) : '';
  if (items) return items;
  return record.description ? paragraphs(record.description) : '';
}
