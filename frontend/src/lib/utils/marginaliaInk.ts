/**
 * Marginalia ink: the hand-drawn marks the reader leaves on an article.
 *
 * A highlight is drawn as a chisel-marker stroke rather than a flat box, and a
 * community highlight as a pencil underline. Both are painted as `background`
 * images on the inline `<mark>` elements themselves, with
 * `box-decoration-break: clone` so every line a passage wraps onto gets its own
 * stroke with its own ends — the way a marker actually crosses a page. Keeping
 * the ink on the marks (instead of an overlay layer measured from them) means it
 * can never drift from the text: it reflows, paginates and re-renders with it.
 *
 * A stroke is three pieces — a left end, a stretchable middle, a right end — so
 * the ragged ends keep their shape at any length. Each piece comes in a few
 * seeded variants (a slightly different tilt and wobble), and a highlight picks
 * one from its id, so the same mark looks identical on every render and the page
 * never shimmers as it re-lays out.
 *
 * The images are data-URI SVGs, which can't read CSS variables, so the colors
 * are baked per theme into a stylesheet built once at runtime. The fills are
 * opaque (pre-mixed onto the page color): translucent pieces would darken
 * wherever the end caps overlap the middle.
 */

export const INK_VARIANTS = 3;

/**
 * The gloss marker: a hand-drawn asterisk, the oldest sign in a book's margin
 * for "there's a note about this". Shown after an annotated passage where
 * there is no margin to hold the note itself (mobile, paged reading); tapping
 * it unfolds the note in place. Other readers' notes wear it in pencil.
 */
export const GLOSS_MARKER_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><path d="M12.4 3.2c-.3 3.1-.2 6.5.1 17.4"/><path d="M4.6 7.9c2.9 1.5 8.4 4.6 14.9 8.1"/><path d="M19.2 7.3c-3.6 2.2-9.1 5.8-14.6 9.4"/></svg>';

/** Small deterministic PRNG (mulberry32), so a seed always draws the same line. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Stable 32-bit hash of a string (FNV-1a). */
export function hashString(value: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Which of the stroke variants a highlight wears. */
export function inkVariant(id: string): number {
  return hashString(id) % INK_VARIANTS;
}

const r1 = (n: number) => Math.round(n * 10) / 10;

interface StrokeShape {
  left: string;
  mid: string;
  right: string;
  /** The darker pooling line along the stroke's lower edge. */
  midPool: string;
}

/**
 * One variant of the marker stroke, in three viewBoxes that share their seams:
 * the left end's right edge and the middle's left edge meet at the same heights
 * (and likewise on the right), so the pieces join without a step.
 */
function strokeShape(variant: number): StrokeShape {
  const rand = seededRandom(0x5eed + variant * 7919);
  // The band sits low in the line box, like a marker dragged through the
  // x-height rather than centered on the ascenders, and a little narrower than
  // the line so the paper shows above and below it.
  const tilt = (rand() - 0.5) * 3.2;
  const topL = 4.2 + rand() * 1.4;
  const botL = 17.6 + rand() * 1.2;
  const topR = topL + tilt;
  const botR = botL + tilt * 0.8;

  // Middle: 200 units wide, a visible wobble on both edges.
  const W = 200;
  const steps = 7;
  const top: [number, number][] = [];
  const bot: [number, number][] = [];
  for (let i = 0; i <= steps; i++) {
    const x = (W * i) / steps;
    const f = i / steps;
    const edge = i === 0 || i === steps ? 0 : 1;
    top.push([x, topL + (topR - topL) * f + edge * (rand() - 0.5) * 2.2]);
    bot.push([x, botL + (botR - botL) * f + edge * (rand() - 0.5) * 1.8]);
  }
  const smooth = (pts: [number, number][]) =>
    pts
      .map(([x, y], i) => {
        if (i === 0) return `M${r1(x)} ${r1(y)}`;
        const [px, py] = pts[i - 1];
        return `Q${r1(px + (x - px) * 0.5)} ${r1(py + (rand() - 0.5) * 0.8)} ${r1(x)} ${r1(y)}`;
      })
      .join(' ');
  const botRev = [...bot].reverse();
  const mid = `${smooth(top)} L${r1(botRev[0][0])} ${r1(botRev[0][1])} ${smooth(botRev).replace(/^M[^Q]+/, '')} Z`;
  // Ink pools along the lower edge where the nib drags.
  const midPool = `M0 ${r1(botL - 2.2)} Q${W / 2} ${r1((botL + botR) / 2 - 1.6 + (rand() - 0.5))} ${W} ${r1(botR - 2.2)} L${W} ${r1(botR)} Q${W / 2} ${r1((botL + botR) / 2 + 0.4)} 0 ${r1(botL)} Z`;

  // Ends: a chisel tip, a slanted cut with a little bleed, 12 units wide. The
  // same slant on both ends, as one marker held at one angle would leave.
  const slant = 5 + rand() * 3;
  const bleed = () => (rand() - 0.5) * 1.6;
  const left = [
    `M12 ${r1(topL)}`,
    `L${r1(Math.min(11, 1 + slant + bleed()))} ${r1(topL + 0.2)}`,
    `Q${r1(slant * 0.55)} ${r1(topL + 3)} ${r1(0.6 + slant * 0.4 + bleed())} ${r1((topL + botL) / 2)}`,
    `Q${r1(0.2)} ${r1(botL - 2.5)} ${r1(0.6 + Math.abs(bleed()) * 0.5)} ${r1(botL + 0.4)}`,
    `L12 ${r1(botL)} Z`,
  ].join(' ');
  const right = [
    `M0 ${r1(topR)}`,
    `L${r1(11.4 - Math.abs(bleed()) * 0.5)} ${r1(topR - 0.4)}`,
    `Q${r1(11.8)} ${r1(topR + 2.5)} ${r1(11.4 - slant * 0.4 + bleed())} ${r1((topR + botR) / 2)}`,
    `Q${r1(12 - slant * 0.55)} ${r1(botR - 3)} ${r1(Math.max(1, 11 - slant + bleed()))} ${r1(botR - 0.2)}`,
    `L0 ${r1(botR)} Z`,
  ].join(' ');
  return { left, mid, right, midPool };
}

/** A tileable pencil line: starts and ends at the same height and slope. */
function pencilTile(): string {
  const rand = seededRandom(0x9e4c11);
  const W = 90;
  const pts: string[] = [`M0 3`];
  const n = 6;
  for (let i = 1; i <= n; i++) {
    const x = (W * i) / n;
    const y = i === n ? 3 : 3 + (rand() - 0.5) * 1.8;
    const cx = x - W / n / 2;
    const cy = 3 + (rand() - 0.5) * 2.2;
    pts.push(`Q${r1(cx)} ${r1(cy)} ${r1(x)} ${r1(y)}`);
  }
  return pts.join(' ');
}

function svgUrl(viewBox: string, body: string): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}" preserveAspectRatio="none">${body}</svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
}

/** A tileable hand-ruled vertical line, for the gloss's left rule. */
function ruleTile(): string {
  const rand = seededRandom(0x6105);
  const H = 80;
  const pts: string[] = ['M3 0'];
  const n = 4;
  for (let i = 1; i <= n; i++) {
    const y = (H * i) / n;
    const x = i === n ? 3 : 3 + (rand() - 0.5) * 1.6;
    pts.push(`Q${r1(3 + (rand() - 0.5) * 2)} ${r1(y - H / n / 2)} ${r1(x)} ${r1(y)}`);
  }
  return pts.join(' ');
}

interface InkPalette {
  fill: string;
  pool: string;
  activeFill: string;
  activePool: string;
  pencil: string;
  pencilActive: string;
  rule: string;
}

// Highlight Gold (#f5c518) pre-mixed onto each theme's page color: ~34% at rest,
// ~50% active on white; ~26% / ~38% on the night surface.
const LIGHT: InkPalette = {
  fill: '#fce8a2',
  pool: '#f9df88',
  activeFill: '#f9dc78',
  activePool: '#f4d05e',
  pencil: '#8a929c',
  pencilActive: '#5f6772',
  rule: '#a4892f',
};
const DARK: InkPalette = {
  fill: '#52461b',
  pool: '#5a4c1b',
  activeFill: '#6a5a1c',
  activePool: '#75631d',
  pencil: '#7f8995',
  pencilActive: '#aeb7c2',
  rule: '#a58b3e',
};

function paletteVars(p: InkPalette): string {
  const lines: string[] = [];
  for (let v = 0; v < INK_VARIANTS; v++) {
    const s = strokeShape(v);
    for (const [state, fill, pool] of [
      ['rest', p.fill, p.pool],
      ['active', p.activeFill, p.activePool],
    ] as const) {
      lines.push(
        `--ink-${v}-${state}-l:${svgUrl('0 0 12 22', `<path d="${s.left}" fill="${fill}"/>`)};`,
        `--ink-${v}-${state}-m:${svgUrl('0 0 200 22', `<path d="${s.mid}" fill="${fill}"/><path d="${s.midPool}" fill="${pool}"/>`)};`,
        `--ink-${v}-${state}-r:${svgUrl('0 0 12 22', `<path d="${s.right}" fill="${fill}"/>`)};`
      );
    }
  }
  const tile = pencilTile();
  for (const [state, color] of [
    ['rest', p.pencil],
    ['active', p.pencilActive],
  ] as const) {
    lines.push(
      `--pencil-${state}:${svgUrl('0 0 90 6', `<path d="${tile}" fill="none" stroke="${color}" stroke-width="1.3" stroke-linecap="round"/>`)};`
    );
  }
  lines.push(
    `--gloss-rule:${svgUrl('0 0 6 80', `<path d="${ruleTile()}" fill="none" stroke="${p.rule}" stroke-width="1.4" stroke-linecap="round"/>`)};`
  );
  return lines.join('');
}

/**
 * Per-variant rules that pick a variant's pieces into the generic custom
 * properties the static stylesheet (app.css, `.marginalia-ink`) paints from.
 */
function variantRules(): string {
  const rules: string[] = [];
  for (let v = 0; v < INK_VARIANTS; v++) {
    const sel = `.marginalia-ink mark.highlight[data-ink='${v}']`;
    rules.push(
      `${sel}{--ink-l:var(--ink-${v}-rest-l);--ink-m:var(--ink-${v}-rest-m);--ink-r:var(--ink-${v}-rest-r);}`,
      `${sel}:hover,${sel}.is-active{--ink-l:var(--ink-${v}-active-l);--ink-m:var(--ink-${v}-active-m);--ink-r:var(--ink-${v}-active-r);}`
    );
  }
  return rules.join('');
}

export function buildInkStylesheet(): string {
  return [
    `:root{${paletteVars(LIGHT)}}`,
    `@media (prefers-color-scheme: dark){:root{${paletteVars(DARK)}}}`,
    variantRules(),
  ].join('\n');
}

const STYLE_ID = 'marginalia-ink';

/** Install the ink stylesheet once per document. Safe to call repeatedly. */
export function installMarginaliaInk(): void {
  if (typeof document === 'undefined' || document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = buildInkStylesheet();
  document.head.appendChild(style);
}

/**
 * A hand-drawn margin bracket (⎫) spanning `height` px, drawn at x≈0..8 in its
 * own box: a wobbly vertical stroke with a hook at each end and a small beak
 * pointing into the margin at the middle. Seeded, so a highlight's bracket keeps
 * its shape across re-layouts.
 */
export function bracketPath(seed: string, height: number): string {
  const rand = seededRandom(hashString(seed));
  const h = Math.max(height, 14);
  const j = () => (rand() - 0.5) * 1.1;
  const mid = h / 2 + j() * 2;
  const x = 5 + j();
  if (h < 34) {
    // A single line of text: a short tick with small hooks, no beak.
    return `M${r1(1 + j())} ${r1(1.5)} Q${r1(x)} ${r1(1 + j())} ${r1(x + j() * 0.5)} ${r1(h * 0.35)} T${r1(x + j() * 0.6)} ${r1(h - 3)} Q${r1(x - 0.5)} ${r1(h - 1)} ${r1(1.2 + j())} ${r1(h - 1)}`;
  }
  return [
    `M${r1(0.8 + j())} ${r1(1.2)}`,
    `Q${r1(x)} ${r1(0.8 + j())} ${r1(x + j() * 0.4)} ${r1(8)}`,
    `L${r1(x + j() * 0.8)} ${r1(mid - 5)}`,
    `Q${r1(x + 0.6)} ${r1(mid - 1)} ${r1(x + 3.4 + j() * 0.4)} ${r1(mid)}`,
    `Q${r1(x + 0.6)} ${r1(mid + 1)} ${r1(x + j() * 0.8)} ${r1(mid + 5)}`,
    `L${r1(x + j() * 0.8)} ${r1(h - 8)}`,
    `Q${r1(x)} ${r1(h - 0.8 + j())} ${r1(0.8 + j())} ${r1(h - 1.2)}`,
  ].join(' ');
}

/**
 * A loose pencil leader from a bracket's beak (0,0) to a note that was pushed
 * down the margin by the notes above it, ending at (dx, dy).
 */
export function leaderPath(seed: string, dx: number, dy: number): string {
  const rand = seededRandom(hashString(seed) ^ 0x1eade7);
  const bow = 6 + rand() * 6;
  return `M0 0 C${r1(bow)} ${r1(dy * 0.15)} ${r1(dx - bow)} ${r1(dy * 0.7)} ${r1(dx)} ${r1(dy)}`;
}
