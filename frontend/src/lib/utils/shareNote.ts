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
