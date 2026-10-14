import type { TextQuoteSelector } from '$lib/types';
import { locateQuote, selectorFromText } from '$lib/utils/textSelector';

/**
 * The text of a saved PDF as the original-pages view sees it, built so that a
 * highlight anchors the same way on the pages as in the reflowed text.
 *
 * Highlights are `TextQuoteSelector`s, and the reflowed text is what the PDF
 * extractor (`pdf-extractor/src/extract.ts`) made of these same pdf.js text
 * runs. So this joins the runs the way it does: whitespace collapsed, a line
 * ending "inter-" joined to a next line starting "national" without its hyphen,
 * and rotated runs (a margin stamp, a watermark) left out. Whatever spacing
 * still differs — the extractor adds a space at a wide gap — is covered by the
 * selector matcher's whitespace-blind second pass, in both directions.
 *
 * Every character of every run keeps its offset into that text, which is what
 * turns a selection on the page into a selector and a selector back into spans
 * of the page's text layer (pdf.js draws one span per run, in this order).
 */

/** The parts of a pdf.js `TextItem` this reads. */
export interface PdfTextRun {
  str: string;
  hasEOL?: boolean;
  transform?: number[];
}

export interface PdfTextModel {
  text: string;
  /**
   * `offsets[page][run][c]` is where character `c` of that run starts in
   * `text`, for `c` in `0..str.length` (the last is where the run ends). A
   * character the text left out (a collapsed space, a line-end hyphen) starts
   * where the next one does, so it takes up no room.
   */
  offsets: Int32Array[][];
}

/** A stretch of one run: characters `[from, to)` of `runs[run]` on `page` (0-based). */
export interface PdfRunSlice {
  page: number;
  run: number;
  from: number;
  to: number;
}

const isSpace = (ch: string) => /\s/.test(ch);

// The extractor drops a run whose baseline is tilted; a slant alone is italic.
function isRotated(run: PdfTextRun): boolean {
  const [a = 1, b = 0] = run.transform ?? [];
  return Math.abs(b) > Math.abs(a) * 0.05;
}

/** Build the model from each page's text runs (`textContent.items`, text items only). */
export function buildPdfTextModel(pages: PdfTextRun[][]): PdfTextModel {
  let text = '';
  // A line (or page) ended since the last character: the next one is joined
  // to it with a space, or, after a broken word, with nothing.
  let atBreak = false;

  const offsets = pages.map((runs) => {
    const pageOffsets = runs.map((run) => {
      const out = new Int32Array(run.str.length + 1);
      const skip = isRotated(run);
      for (let c = 0; c < run.str.length; c++) {
        const ch = run.str[c];
        if (skip) {
          out[c] = text.length;
          continue;
        }
        if (isSpace(ch)) {
          out[c] = text.length;
          if (text && !atBreak && !text.endsWith(' ')) text += ' ';
          continue;
        }
        if (atBreak) {
          text = text.trimEnd();
          if (/[a-z]-$/.test(text) && /[a-z]/.test(ch)) text = text.slice(0, -1);
          else if (text) text += ' ';
          atBreak = false;
        }
        out[c] = text.length;
        text += ch;
      }
      out[run.str.length] = text.length;
      if (run.hasEOL && !skip) atBreak = true;
      return out;
    });
    atBreak = true;
    return pageOffsets;
  });

  // The joins above can step back over a trailing space, leaving an offset one
  // past the end; nothing can start there.
  text = text.trimEnd();
  for (const page of offsets)
    for (const run of page)
      for (let c = 0; c < run.length; c++) if (run[c] > text.length) run[c] = text.length;

  return { text, offsets };
}

/** Where a point inside a run (character `c` of `runs[run]` on `page`) falls in the text. */
export function textOffsetAt(model: PdfTextModel, page: number, run: number, c: number): number {
  const runOffsets = model.offsets[page]?.[run];
  if (!runOffsets) return 0;
  return Math.min(runOffsets[Math.max(0, Math.min(c, runOffsets.length - 1))], model.text.length);
}

/**
 * The selector for the text between two offsets, trimmed of the spaces at its
 * ends. Null when nothing but space lies between them.
 */
export function selectorForSpan(
  model: PdfTextModel,
  start: number,
  end: number
): TextQuoteSelector | null {
  let s = Math.max(0, Math.min(start, end));
  let e = Math.min(model.text.length, Math.max(start, end));
  while (s < e && isSpace(model.text[s])) s++;
  while (e > s && isSpace(model.text[e - 1])) e--;
  if (s >= e) return null;
  return selectorFromText(model.text, s, e);
}

/** The run slices a span of the text covers, page by page, in order. */
export function slicesForSpan(model: PdfTextModel, start: number, end: number): PdfRunSlice[] {
  const slices: PdfRunSlice[] = [];
  if (end <= start) return slices;
  model.offsets.forEach((runs, page) => {
    // Offsets only grow, so a page that starts after the span or ends before
    // it is skipped whole.
    const first = runs[0];
    const last = runs[runs.length - 1];
    if (!first || !last || last[last.length - 1] <= start || first[0] >= end) return;
    runs.forEach((offsets, run) => {
      if (offsets.length < 2 || offsets[offsets.length - 1] <= start || offsets[0] >= end) return;
      let from = -1;
      let to = -1;
      for (let c = 0; c < offsets.length - 1; c++) {
        if (offsets[c] >= start && offsets[c] < end) {
          if (from < 0) from = c;
          to = c + 1;
        }
      }
      if (from >= 0) slices.push({ page, run, from, to });
    });
  });
  return slices;
}

/** Where a highlight's quote falls on the pages, or null when it isn't in this PDF's text. */
export function locateInPdf(
  model: PdfTextModel,
  selector: TextQuoteSelector
): PdfRunSlice[] | null {
  const hit = locateQuote(selector, model.text);
  if (!hit) return null;
  const slices = slicesForSpan(model, hit.start, hit.end);
  return slices.length ? slices : null;
}
