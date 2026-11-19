import type { ShareDraftBlock } from '$lib/types';

/**
 * Share-note ↔ draft-block conversion.
 *
 * The linkblog write path speaks a deliberately tiny Markdown subset: a leading
 * `> ` marks a blockquote line, everything else is plain text (see backend
 * noteRuns / frontend linkPostNote.ts). The share composer edits the same note
 * as an ordered list of blocks — commentary text and atomic quoted passages —
 * so quotes render as real blockquotes while the wire format stays unchanged.
 */

/** Serialize composer blocks to the note's Markdown. Empty blocks drop out. */
export function blocksToNote(blocks: ShareDraftBlock[]): string {
  const parts: string[] = [];
  for (const block of blocks) {
    const text = block.text.trim();
    if (!text) continue;
    if (block.kind === 'quote') {
      parts.push(
        text
          .split('\n')
          .map((line) => `> ${line.trim()}`)
          .join('\n')
      );
    } else {
      parts.push(text);
    }
  }
  return parts.join('\n\n');
}

/**
 * Parse a note's Markdown back into composer blocks. Consecutive `>`-prefixed
 * lines fold into one quote block; everything else accumulates into text blocks
 * (blank-line paragraph breaks preserved inside them). Always returns at least
 * one text block, and always ends on one, so the composer has somewhere to type.
 */
export function noteToBlocks(note: string | undefined | null): ShareDraftBlock[] {
  const blocks: ShareDraftBlock[] = [];
  const lines = (note ?? '').split('\n');
  let quote: string[] | null = null;
  let text: string[] | null = null;

  const flushQuote = () => {
    if (quote) {
      const t = quote.join('\n').trim();
      if (t) blocks.push({ kind: 'quote', text: t });
      quote = null;
    }
  };
  const flushText = () => {
    if (text) {
      const t = text.join('\n').trim();
      if (t) blocks.push({ kind: 'text', text: t });
      text = null;
    }
  };

  for (const line of lines) {
    const m = /^[ \t]*>[ \t]?(.*)$/.exec(line);
    if (m) {
      flushText();
      (quote ??= []).push(m[1]);
    } else {
      flushQuote();
      (text ??= []).push(line);
    }
  }
  flushQuote();
  flushText();

  if (blocks.length === 0 || blocks[blocks.length - 1].kind !== 'text') {
    blocks.push({ kind: 'text', text: '' });
  }
  return blocks;
}

/** Word count across all blocks, for the minimized-drawer summary. */
export function draftWordCount(blocks: ShareDraftBlock[]): number {
  let count = 0;
  for (const block of blocks) {
    count += block.text.split(/\s+/).filter(Boolean).length;
  }
  return count;
}

/** Whether a draft has any real content worth keeping. */
export function draftHasContent(blocks: ShareDraftBlock[]): boolean {
  return blocks.some((b) => b.text.trim().length > 0);
}

// ── The single editor ─────────────────────────────────────────────────────────
// The composer edits the note as one plain text: commentary as written, quoted
// lines prefixed `> ` — the same subset the wire format speaks, so moving a
// passage is cut and paste, and the blocks above are derived from the text.

const QUOTE_LINE = /^[ \t]*>[ \t]?/;

/** Whether a line of the draft is a quoted line. */
export function isQuoteLine(line: string): boolean {
  return QUOTE_LINE.test(line);
}

/**
 * Blocks (a saved draft, a parsed note) as editor text. Ends ready to type
 * commentary: a draft that ends on a quote gets a blank line after it.
 */
export function blocksToText(blocks: ShareDraftBlock[]): string {
  const note = blocksToNote(blocks);
  const filled = blocks.filter((b) => b.text.trim());
  return filled.length && filled[filled.length - 1].kind === 'quote' ? `${note}\n\n` : note;
}

/** A passage as quoted lines. A blank line inside it stays inside the quote. */
export function quoteLines(passage: string): string {
  return passage
    .trim()
    .split('\n')
    .map((line) => (line.trim() ? `> ${line.trim()}` : '>'))
    .join('\n');
}

export interface TextEdit {
  text: string;
  selectionStart: number;
  selectionEnd: number;
}

/**
 * Insert a quoted passage as its own paragraph: after the paragraph the caret
 * is in (never splitting a sentence), or at the end when there's no caret.
 * Leaves the caret on the line after it, ready for commentary.
 */
export function insertQuote(text: string, passage: string, caret?: number): TextEdit {
  const quoted = quoteLines(passage);
  let at = text.length;
  if (caret !== undefined) {
    const blank = /\n[ \t]*\n/g;
    blank.lastIndex = Math.max(0, Math.min(caret, text.length));
    // A caret already on a blank line inserts right there.
    const lineStart = text.lastIndexOf('\n', caret - 1) + 1;
    const lineEndRaw = text.indexOf('\n', caret);
    const lineEnd = lineEndRaw === -1 ? text.length : lineEndRaw;
    if (text.slice(lineStart, lineEnd).trim() === '') at = lineStart;
    else {
      const m = blank.exec(text);
      at = m ? m.index : text.length;
    }
  }
  const before = text.slice(0, at).replace(/\s+$/, '');
  const after = text.slice(at).replace(/^\s+/, '');
  const head = before ? `${before}\n\n${quoted}\n\n` : `${quoted}\n\n`;
  const caretAt = head.length;
  return { text: head + after, selectionStart: caretAt, selectionEnd: caretAt };
}

/** The whole lines a selection touches, as [start, end) offsets. */
function lineSpan(text: string, start: number, end: number): [number, number] {
  const from = text.lastIndexOf('\n', start - 1) + 1;
  // A selection ending at the very start of a line doesn't take that line.
  const last = end > start && text[end - 1] === '\n' ? end - 1 : end;
  const nl = text.indexOf('\n', last);
  return [from, nl === -1 ? text.length : nl];
}

/**
 * Turn the selected lines into a quote, or back into commentary when they're
 * all quoted already. Blank lines stay blank, so two paragraphs quoted
 * together stay two quotes. The edited lines come back selected.
 */
export function toggleQuote(text: string, start: number, end: number): TextEdit {
  const [from, to] = lineSpan(text, start, end);
  const lines = text.slice(from, to).split('\n');
  const filled = lines.filter((l) => l.trim());
  const unquote = filled.length > 0 && filled.every(isQuoteLine);
  const next = lines.map((line) => {
    if (!line.trim()) return line;
    if (unquote) return line.replace(QUOTE_LINE, '');
    return isQuoteLine(line) ? line : `> ${line}`;
  });
  const body = next.join('\n');
  return {
    text: text.slice(0, from) + body + text.slice(to),
    selectionStart: from,
    selectionEnd: from + body.length,
  };
}

/**
 * Move the paragraph the caret is in up or down past its neighbour. A
 * paragraph is a run of non-blank lines of one kind, so a quote moves apart
 * from commentary written right under it. The caret moves with it.
 */
export function moveParagraph(text: string, caret: number, dir: -1 | 1): TextEdit | null {
  interface Unit {
    start: number;
    end: number;
  }
  const units: Unit[] = [];
  let pos = 0;
  let current: (Unit & { quote: boolean }) | null = null;
  for (const line of text.split('\n')) {
    const start = pos;
    const end = pos + line.length;
    pos = end + 1;
    if (!line.trim()) {
      if (current) units.push(current);
      current = null;
      continue;
    }
    const quote = isQuoteLine(line);
    if (current && current.quote === quote) current.end = end;
    else {
      if (current) units.push(current);
      current = { start, end, quote };
    }
  }
  if (current) units.push(current);

  const i = units.findIndex((u) => caret >= u.start && caret <= u.end);
  const j = i + dir;
  if (i === -1 || j < 0 || j >= units.length) return null;

  const pieces = units.map((u) => text.slice(u.start, u.end));
  [pieces[i], pieces[j]] = [pieces[j], pieces[i]];
  const lead = text.slice(0, units[0].start);
  const trail = text.slice(units[units.length - 1].end);
  const offset = caret - units[i].start;
  let moved = lead.length;
  for (let k = 0; k < j; k++) moved += pieces[k].length + 2;
  const caretAt = moved + offset;
  return {
    text: lead + pieces.join('\n\n') + trail,
    selectionStart: caretAt,
    selectionEnd: caretAt,
  };
}
