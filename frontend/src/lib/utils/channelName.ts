// Names a channel from what's in it, the same way wherever one is made: the
// toolbar's Save, the mobile sheet's "Save as channel" and the channel editor.

import type { Subscription } from '$lib/types';
import {
  FOLLOWS_CHANNEL_NAME,
  FOLLOWS_SOURCE_KEY,
  subscriptionSourceKey,
} from '$lib/utils/sourceKeys';
import { groupLabel, type SourceFilter } from '$lib/utils/sourceFilter';

/** Terse label for a list of names: "A", "A & B", "A +2". */
export function joinNames(names: string[]): string {
  if (names.length === 1) return names[0];
  if (names.length === 2) return `${names[0]} & ${names[1]}`;
  return `${names[0]} +${names.length - 1}`;
}

/** Describe a source filter well enough to recognise, short enough to read ('' for Everything). */
export function sourceFilterName(
  filter: SourceFilter,
  subscriptions: readonly Subscription[],
  followsInEverything: boolean
): string {
  const titles = new Map<string, string>();
  for (const sub of subscriptions) {
    const key = subscriptionSourceKey(sub);
    if (key) titles.set(key, sub.customTitle || sub.title);
  }
  titles.set(FOLLOWS_SOURCE_KEY, FOLLOWS_CHANNEL_NAME);

  const names = filter.sourceKeys
    .filter(
      (k) => filter.sourceMode === 'include' || followsInEverything || k !== FOLLOWS_SOURCE_KEY
    )
    .map((k) => titles.get(k) ?? groupLabel(k))
    .filter((n): n is string => !!n);

  if (filter.sourceMode === 'include' && names.length > 0) return joinNames(names);
  if (filter.sourceMode === 'exclude' && names.length > 0) return `Without ${joinNames(names)}`;
  if (filter.sourceMode === 'exclude') return `Everything + ${FOLLOWS_CHANNEL_NAME}`;
  return '';
}

/** Append " 2", " 3"… so a generated name never collides with an existing channel. */
export function uniqueChannelName(base: string, takenNames: Iterable<string>): string {
  const taken = new Set(takenNames);
  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(`${base} ${n}`)) n++;
  return `${base} ${n}`;
}
