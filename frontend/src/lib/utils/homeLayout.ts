// The reader's arrangement of the Home view: which sections show and in what
// order. Sections are addressed by stable ids — fixed ones for the built-in
// lanes, `room:<subject>` / `channel:<uuid>` for the per-room and per-channel
// lanes — so a layout survives those coming and going. Pure, so the merge rule
// is testable without the page.

import type { IconName } from '$lib/components/Icon.svelte';

export interface HomeLayout {
  /** Section ids in the reader's chosen order. May name sections that no longer exist. */
  order: string[];
  /** Section ids the reader has hidden. */
  hidden: string[];
}

/** One row in the Customize Home dialog. */
export interface HomeSectionOption {
  id: string;
  label: string;
  icon: IconName;
  /** Quiet qualifier after the label, e.g. "Room" or "Channel". */
  kind?: string;
}

export const EMPTY_HOME_LAYOUT: HomeLayout = { order: [], hidden: [] };

export const HOME_SECTION = {
  highlights: 'highlights',
  magazine: 'magazine',
  continue: 'continue',
  follows: 'follows',
  random: 'random',
  recent: 'recent',
} as const;

export function roomSectionId(subject: string): string {
  return `room:${subject}`;
}

export function channelSectionId(uuid: string): string {
  return `channel:${uuid}`;
}

/**
 * Forget sections of channels that no longer exist, so deleted channels don't
 * pile up in the saved layout. Channels are local and loaded up front, so
 * absence means deleted; rooms load late and are kept (see mergeHomeOrder).
 * An empty `channelUuids` means "not loaded", not "all deleted", and prunes nothing.
 */
export function pruneHomeLayout(layout: HomeLayout, channelUuids: Set<string>): HomeLayout {
  if (channelUuids.size === 0) return layout;
  const keep = (id: string) =>
    !id.startsWith('channel:') || channelUuids.has(id.slice('channel:'.length));
  return { order: layout.order.filter(keep), hidden: layout.hidden.filter(keep) };
}

/** localStorage is user-editable; only trust a layout made of string lists. */
export function coerceHomeLayout(value: unknown): HomeLayout {
  if (!value || typeof value !== 'object') return EMPTY_HOME_LAYOUT;
  const v = value as Record<string, unknown>;
  const strings = (x: unknown) =>
    Array.isArray(x) ? x.filter((s): s is string => typeof s === 'string') : [];
  return { order: strings(v.order), hidden: strings(v.hidden) };
}

/**
 * Order the sections that exist now (`defaults`, in their built-in order) by the
 * reader's saved order. A section the saved order doesn't mention yet — a room
 * joined or channel created since the reader last arranged Home — slots in right
 * after the section that precedes it in the built-in order, so it lands near its
 * kin rather than at the very bottom. Saved ids that no longer exist drop out.
 */
export function orderHomeSections(defaults: string[], saved: string[]): string[] {
  const present = new Set(defaults);
  const out = saved.filter((id, i) => present.has(id) && saved.indexOf(id) === i);
  const placed = new Set(out);
  for (let i = 0; i < defaults.length; i++) {
    const id = defaults[i];
    if (placed.has(id)) continue;
    // Nearest earlier built-in neighbour that's already placed.
    let at = 0;
    for (let j = i - 1; j >= 0; j--) {
      const idx = out.indexOf(defaults[j]);
      if (idx !== -1) {
        at = idx + 1;
        break;
      }
    }
    out.splice(at, 0, id);
    placed.add(id);
  }
  return out;
}

/** Move `id` one step up (-1) or down (+1) within `order`. No-op at the ends. */
export function moveHomeSection(order: string[], id: string, delta: -1 | 1): string[] {
  const i = order.indexOf(id);
  const j = i + delta;
  if (i === -1 || j < 0 || j >= order.length) return order;
  const next = [...order];
  [next[i], next[j]] = [next[j], next[i]];
  return next;
}

/**
 * Fold a newly arranged order of the sections present now back into the saved
 * one. A saved id that isn't present at the moment (a room whose list hasn't
 * loaded yet, say) keeps its place after the same neighbour instead of being
 * forgotten because the reader rearranged Home while it was away.
 */
export function mergeHomeOrder(previous: string[], next: string[]): string[] {
  const known = new Set(previous);
  return orderHomeSections([...previous, ...next.filter((id) => !known.has(id))], next);
}
