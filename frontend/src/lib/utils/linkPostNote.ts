import type { LeafletBlockWrapper, LeafletFacet } from '$lib/types';

export function noteToLeafletBlocks(note: string | null | undefined): LeafletBlockWrapper[] {
  const text = note?.trim();
  if (!text) return [];
  const blocks: LeafletBlockWrapper[] = [];
  let kind: 'text' | 'blockquote' | undefined;
  let lines: string[] = [];
  const flush = () => {
    if (!kind || lines.length === 0) return;
    blocks.push({
      block: {
        $type: `pub.leaflet.blocks.${kind}`,
        plaintext: lines.join('\n'),
      } as LeafletBlockWrapper['block'],
    });
    kind = undefined;
    lines = [];
  };
  for (const line of text.split('\n')) {
    const quote = line.match(/^> ?(.*)$/);
    if (!quote && line.trim() === '') {
      flush();
      continue;
    }
    const nextKind = quote ? 'blockquote' : 'text';
    if (kind && kind !== nextKind) flush();
    kind = nextKind;
    lines.push(quote ? quote[1] : line);
  }
  flush();
  return blocks;
}

/**
 * The opt-in "this came from Skyreader" line. MUST match the backend's
 * ATTRIBUTION_TEXT — it's the fallback tell for records whose top-level
 * `skyreaderAttribution` flag didn't survive whatever pulled them.
 */
export const ATTRIBUTION_TEXT = 'Posted from skyreader.app';

/**
 * Whether a block is the attribution line rather than the author's words.
 *
 * `hasAttribution` (the record's own flag) is the reliable signal; the string
 * match is the fallback, and it's why the flag exists — someone whose last line
 * happens to be that exact sentence would otherwise lose it. Bounded to a
 * trailing-line match either way.
 */
export function isAttributionText(plaintext: string, hasAttribution?: boolean): boolean {
  if (hasAttribution === false) return false;
  return plaintext.trim() === ATTRIBUTION_TEXT;
}

export interface ReconstructedMention {
  byteStart: number;
  byteEnd: number;
  did: string;
}

const MENTION_TYPES = new Set([
  'pub.leaflet.richtext.facet#didMention',
  'pub.leaflet.richtext.facet#mention',
  'app.bsky.richtext.facet#mention',
]);

function mentionDid(facet: LeafletFacet): string | undefined {
  return facet.features?.find(
    (feature) => MENTION_TYPES.has(feature.$type) && feature.did?.startsWith('did:')
  )?.did;
}

function quoteOffset(plaintext: string, byteOffset: number): number {
  const prefix = new TextEncoder().encode(plaintext).slice(0, byteOffset);
  let newlines = 0;
  for (const byte of prefix) if (byte === 10) newlines++;
  return byteOffset + 2 * (newlines + 1);
}

/**
 * The user's commentary, rebuilt from the native text and blockquote blocks.
 *
 * The website card no longer closes the post — it can sit between the quote and
 * the commentary, or lead — so non-note blocks are SKIPPED rather than treated as
 * the end of the note. (Breaking at the first one silently truncated every note
 * written in the new layout at the card.) The card contributes no note bytes, so
 * mention byte offsets are unaffected by where it sits.
 *
 * The "Posted from Skyreader" line is ours, not the author's, so it's excluded —
 * by the record's `skyreaderAttribution` flag where the caller has it, and by the
 * constant string otherwise.
 */
export function reconstructLinkPostNote(
  blocks: LeafletBlockWrapper[],
  options: { hasAttribution?: boolean } = {}
): {
  note?: string;
  mentions: ReconstructedMention[];
} {
  const parts: string[] = [];
  const mentions: ReconstructedMention[] = [];
  let outputBytes = 0;

  for (const wrapper of blocks) {
    const block = wrapper.block;
    if (
      block.$type !== 'pub.leaflet.blocks.text' &&
      block.$type !== 'pub.leaflet.blocks.blockquote'
    )
      continue;
    if (!('plaintext' in block) || !block.plaintext.trim()) continue;
    if (isAttributionText(block.plaintext, options.hasAttribution)) continue;
    const isQuote = block.$type === 'pub.leaflet.blocks.blockquote';
    const rendered = isQuote
      ? block.plaintext
          .split('\n')
          .map((line) => `> ${line}`)
          .join('\n')
      : block.plaintext;
    if (parts.length > 0) outputBytes += 2;
    for (const facet of block.facets ?? []) {
      const did = mentionDid(facet);
      const { byteStart, byteEnd } = facet.index ?? {};
      if (!did || typeof byteStart !== 'number' || typeof byteEnd !== 'number') continue;
      mentions.push({
        byteStart: outputBytes + (isQuote ? quoteOffset(block.plaintext, byteStart) : byteStart),
        byteEnd: outputBytes + (isQuote ? quoteOffset(block.plaintext, byteEnd) : byteEnd),
        did,
      });
    }
    parts.push(rendered);
    outputBytes += new TextEncoder().encode(rendered).length;
  }
  const note = parts.join('\n\n').trim();
  return { note: note || undefined, mentions };
}
