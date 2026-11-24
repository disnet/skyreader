/**
 * Text shots: a quoted passage drawn as an image, for a Bluesky post that
 * quotes more than its 300 characters could hold.
 *
 * Drawn the way the reader draws a quoted highlight — the article's serif on
 * true white, with the 3px Highlight Gold rule — and signed with the article's
 * title and site underneath, so the image still says where it came from once
 * it's been reposted away from the link.
 */

// Rendered at 2x: 600 CSS pixels wide, crisp on a phone.
const SCALE = 2;
const WIDTH = 600 * SCALE;
const PAD_X = 40 * SCALE;
const PAD_Y = 36 * SCALE;
const RULE_WIDTH = 3 * SCALE;
const RULE_GAP = 20 * SCALE;
const QUOTE_SIZE = 20 * SCALE;
const QUOTE_LINE = 32 * SCALE;
const META_SIZE = 13 * SCALE;
const META_LINE = 20 * SCALE;
const META_GAP = 24 * SCALE;
// A list item's text hangs this far in, its bullet or number in the space.
const LIST_INDENT = 24 * SCALE;
// The extra space between one block of the passage and the next.
const BLOCK_GAP = 10 * SCALE;
// Past this the passage is cut with an ellipsis; a text shot is a quote, not the article.
const MAX_QUOTE_LINES = 24;
const MAX_BYTES = 950_000;

const SERIF = "Charter, 'Bitstream Charter', 'Iowan Old Style', Georgia, Cambria, serif";
const SANS = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, sans-serif";
const TEXT = '#1a1a1a';
const TEXT_SECONDARY = '#666666';
const GOLD = 'rgba(245, 197, 24, 0.7)';

/**
 * Break `text` into lines no wider than `maxWidth`. Paragraph breaks are kept;
 * a single word wider than the line is broken by character.
 */
export function wrapLines(
  text: string,
  maxWidth: number,
  measure: (s: string) => number
): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split(/\n+/)) {
    const words = paragraph.trim().split(/\s+/).filter(Boolean);
    let line = '';
    for (const word of words) {
      const candidate = line ? `${line} ${word}` : word;
      if (measure(candidate) <= maxWidth) {
        line = candidate;
        continue;
      }
      if (line) lines.push(line);
      if (measure(word) <= maxWidth) {
        line = word;
        continue;
      }
      // A URL or other unbroken run: split it wherever it has to go.
      let piece = '';
      for (const ch of word) {
        if (piece && measure(piece + ch) > maxWidth) {
          lines.push(piece);
          piece = '';
        }
        piece += ch;
      }
      line = piece;
    }
    if (line) lines.push(line);
  }
  return lines;
}

/** Cap `lines` at `max`, ending the last kept line with an ellipsis. */
export function capLines(
  lines: string[],
  max: number,
  maxWidth: number,
  measure: (s: string) => number
): string[] {
  if (lines.length <= max) return lines;
  const kept = lines.slice(0, max);
  let last = kept[max - 1];
  while (last && measure(`${last}…`) > maxWidth) last = last.slice(0, -1);
  kept[max - 1] = `${last.trimEnd()}…`;
  return kept;
}

/** One drawn line of the quote. */
export interface QuoteLine {
  text: string;
  /** How far in from the quote's left edge the text sits. */
  indent: number;
  /** A list item's bullet or number, drawn in the indent of its first line. */
  marker?: string;
  /** This line starts a new block of the passage (not the first). */
  blockStart?: boolean;
}

// A list item, as `passageText` writes one: a bullet or a number, then a space.
const LIST_MARKER = /^(•|\d+\.)\s+/;

/**
 * Lay out a passage that may keep its blocks: one per line of `quote`, a list
 * item's text hanging after its marker. Capped at `maxLines`, the last kept
 * line ending in an ellipsis.
 */
export function layoutQuote(
  quote: string,
  maxWidth: number,
  measure: (s: string) => number,
  maxLines: number,
  listIndent: number
): QuoteLine[] {
  const blocks = quote
    .split(/\n+/)
    .map((block) => block.trim())
    .filter(Boolean);
  // Only a passage of several blocks has list items: a one-line quote that
  // starts "1984." is just a quote.
  const itemOf = (block: string) => (blocks.length > 1 ? LIST_MARKER.exec(block) : null);
  // The indent fits the widest marker, so "10." never runs into its text.
  const hang = Math.max(
    listIndent,
    ...blocks.map((b) => itemOf(b)).map((m) => (m ? measure(m[1]) + measure(' ') * 1.5 : 0))
  );
  const lines: QuoteLine[] = [];
  for (const trimmed of blocks) {
    const match = itemOf(trimmed);
    const indent = match ? hang : 0;
    const body = match ? trimmed.slice(match[0].length) : trimmed;
    wrapLines(body, maxWidth - indent, measure).forEach((text, i) =>
      lines.push({
        text,
        indent,
        ...(i === 0 && match ? { marker: match[1] } : {}),
        ...(i === 0 && lines.length > 0 ? { blockStart: true } : {}),
      })
    );
  }
  if (lines.length <= maxLines) return lines;
  const kept = lines.slice(0, maxLines);
  const last = kept[maxLines - 1];
  const [cut] = capLines([last.text, ''], 1, maxWidth - last.indent, measure);
  kept[maxLines - 1] = { ...last, text: cut };
  return kept;
}

export interface TextShot {
  blob: Blob;
  width: number;
  height: number;
}

function toBlob(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob> {
  return new Promise((resolve, reject) =>
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error('canvas export failed'))),
      type,
      quality
    )
  );
}

export async function renderTextShot(
  quote: string,
  source: { title?: string; domain?: string }
): Promise<TextShot> {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('canvas unavailable');

  const textLeft = PAD_X + RULE_WIDTH + RULE_GAP;
  const textWidth = WIDTH - textLeft - PAD_X;
  const metaWidth = WIDTH - 2 * PAD_X;

  ctx.font = `${QUOTE_SIZE}px ${SERIF}`;
  const measureQuote = (s: string) => ctx.measureText(s).width;
  const quoteLines = layoutQuote(quote, textWidth, measureQuote, MAX_QUOTE_LINES, LIST_INDENT);
  // Where each line sits: a line height apiece, and a little more before a new block.
  const lineTops: number[] = [];
  let quoteHeight = 0;
  for (const line of quoteLines) {
    if (line.blockStart) quoteHeight += BLOCK_GAP;
    lineTops.push(quoteHeight);
    quoteHeight += QUOTE_LINE;
  }

  ctx.font = `600 ${META_SIZE}px ${SANS}`;
  const measureMeta = (s: string) => ctx.measureText(s).width;
  const metaLines = [
    ...(source.title
      ? capLines(wrapLines(source.title, metaWidth, measureMeta), 1, metaWidth, measureMeta)
      : []),
    ...(source.domain ? [source.domain] : []),
  ];

  const metaHeight = metaLines.length > 0 ? META_GAP + metaLines.length * META_LINE : 0;
  const height = Math.round(PAD_Y * 2 + quoteHeight + metaHeight);

  canvas.width = WIDTH;
  canvas.height = height;
  // Resizing a canvas resets its state, so styling starts here.
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, WIDTH, height);

  ctx.fillStyle = GOLD;
  ctx.fillRect(PAD_X, PAD_Y, RULE_WIDTH, quoteHeight);

  ctx.fillStyle = TEXT;
  ctx.font = `${QUOTE_SIZE}px ${SERIF}`;
  ctx.textBaseline = 'middle';
  quoteLines.forEach((line, i) => {
    const y = PAD_Y + lineTops[i] + QUOTE_LINE / 2;
    if (line.marker) ctx.fillText(line.marker, textLeft, y);
    ctx.fillText(line.text, textLeft + line.indent, y);
  });

  // The title reads as the attribution; the site sits quieter beneath it.
  metaLines.forEach((line, i) => {
    const isTitle = Boolean(source.title) && i === 0;
    ctx.fillStyle = isTitle ? TEXT : TEXT_SECONDARY;
    ctx.font = `${isTitle ? '600 ' : ''}${META_SIZE}px ${SANS}`;
    ctx.fillText(line, PAD_X, PAD_Y + quoteHeight + META_GAP + META_LINE * (i + 0.5));
  });

  // Text on white compresses well as PNG; JPEG is the fallback for a long one.
  let blob = await toBlob(canvas, 'image/png');
  if (blob.size > MAX_BYTES) blob = await toBlob(canvas, 'image/jpeg', 0.9);
  if (blob.size > MAX_BYTES) blob = await toBlob(canvas, 'image/jpeg', 0.75);
  return { blob, width: WIDTH, height };
}
