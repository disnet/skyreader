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
  const quoteLines = capLines(
    wrapLines(quote, textWidth, measureQuote),
    MAX_QUOTE_LINES,
    textWidth,
    measureQuote
  );

  ctx.font = `600 ${META_SIZE}px ${SANS}`;
  const measureMeta = (s: string) => ctx.measureText(s).width;
  const metaLines = [
    ...(source.title
      ? capLines(wrapLines(source.title, metaWidth, measureMeta), 1, metaWidth, measureMeta)
      : []),
    ...(source.domain ? [source.domain] : []),
  ];

  const quoteHeight = quoteLines.length * QUOTE_LINE;
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
  quoteLines.forEach((line, i) => ctx.fillText(line, textLeft, PAD_Y + QUOTE_LINE * (i + 0.5)));

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
