// One filter for where items come from: a checklist of sources, grouped.
//
// A channel (or the toolbar's working copy) is a source filter:
//   - 'all'      Everything. Every source, plus your follows' links when the
//                reader has put them in Everything (followLinksStore.inEverything).
//   - 'include'  only the listed sources.
//   - 'exclude'  every source, your follows' links included, except the listed
//                ones. Self-contained, so a saved channel never changes meaning
//                with the Everything setting: leaving Everything for an
//                exclude filter carries "no follows" over as an explicit key.
//
// A key is a concrete source (`rss~{rkey}`, `{rkey}~documents`, `bsky~follows`)
// or a group key. A group stands for its members as they are when the filter is
// read, so "only Newsletters" takes in a newsletter subscribed to next week and
// "everything but Newsletters" keeps leaving it out. The old Type filter was the
// same idea, kept on a separate axis; `upgradeChannelFilter` folds it in.

import type { FilteredView, Subscription } from '$lib/types';
import { isArchiveFeedSource, isNewsletterSubscription } from '$lib/utils/newsletters';
import { bskySourceKind } from '$lib/utils/bskySources';
import { FOLLOWS_SOURCE_KEY, subscriptionSourceKey } from '$lib/utils/sourceKeys';

export type SourceMode = 'all' | 'include' | 'exclude';

export interface SourceFilter {
  sourceMode: SourceMode;
  sourceKeys: string[];
}

// --- Groups ---

export const GROUP_PREFIX = 'group~';
/** Feeds and standard.site publications: everything you read that isn't mail or Bluesky. */
export const GROUP_PUBLICATIONS = 'group~publications';
export const GROUP_NEWSLETTERS = 'group~newsletters';
/** The posts you liked on Bluesky that carry a link (one subscription). */
export const GROUP_LIKES = 'group~likes';
/** The posts you bookmarked on Bluesky that carry a link (one subscription). */
export const GROUP_BOOKMARKS = 'group~bookmarks';
// Not offered in the picker: they only carry an old "RSS Feeds" or
// "Standard.site Documents" type filter forward exactly.
export const GROUP_FEEDS = 'group~feeds';
export const GROUP_DOCUMENTS = 'group~documents';

export const GROUP_LABELS: Record<string, string> = {
  [GROUP_PUBLICATIONS]: 'Publications',
  [GROUP_NEWSLETTERS]: 'Newsletters',
  [GROUP_LIKES]: 'Your likes',
  [GROUP_BOOKMARKS]: 'Your bookmarks',
  [GROUP_FEEDS]: 'Feeds',
  [GROUP_DOCUMENTS]: 'Standard.site',
};

export function isGroupKey(key: string): boolean {
  return key.startsWith(GROUP_PREFIX);
}

/** Group key → the concrete keys it stands for right now. */
export type SourceGroups = ReadonlyMap<string, readonly string[]>;

type GroupSub = Pick<Subscription, 'rkey' | 'sourceType' | 'feedUrl'>;

/** Which group a subscription's items belong to, by what the reader sees. */
export function sourceGroupOf(sub: GroupSub): string | null {
  if (isNewsletterSubscription(sub)) return GROUP_NEWSLETTERS;
  const bsky = bskySourceKind(sub);
  if (bsky) return bsky === 'likes' ? GROUP_LIKES : GROUP_BOOKMARKS;
  if (sub.sourceType === 'atproto.documents' || isArchiveFeedSource(sub.sourceType)) {
    return GROUP_PUBLICATIONS;
  }
  return null;
}

export function buildSourceGroups(subscriptions: readonly GroupSub[]): SourceGroups {
  const groups = new Map<string, string[]>([
    [GROUP_PUBLICATIONS, []],
    [GROUP_NEWSLETTERS, []],
    [GROUP_LIKES, []],
    [GROUP_BOOKMARKS, []],
    [GROUP_FEEDS, []],
    [GROUP_DOCUMENTS, []],
  ]);
  for (const sub of subscriptions) {
    const key = subscriptionSourceKey(sub as Subscription);
    const group = key ? sourceGroupOf(sub) : null;
    if (!key || !group) continue;
    groups.get(group)!.push(key);
    if (group === GROUP_PUBLICATIONS) {
      groups.get(sub.sourceType === 'atproto.documents' ? GROUP_DOCUMENTS : GROUP_FEEDS)!.push(key);
    }
  }
  return groups;
}

function membersOf(key: string, groups: SourceGroups): readonly string[] {
  return isGroupKey(key) ? (groups.get(key) ?? []) : [key];
}

/** Replace group keys with their members, for the code that matches items. */
export function expandSourceKeys(keys: readonly string[], groups: SourceGroups): string[] {
  const out = new Set<string>();
  for (const key of keys) for (const m of membersOf(key, groups)) out.add(m);
  return [...out];
}

// --- Checklist state ---

export interface PickerContext {
  groups: SourceGroups;
  /** Whether Everything carries your follows' links (the account setting). */
  followsInEverything: boolean;
}

/** The keys an exclude filter starts from when it leaves Everything. */
function everythingExclusions(ctx: PickerContext): string[] {
  return ctx.followsInEverything ? [] : [FOLLOWS_SOURCE_KEY];
}

function coveredBy(keys: readonly string[], ctx: PickerContext): Set<string> {
  return new Set(expandSourceKeys(keys, ctx.groups));
}

/** Is this source (a concrete key) shown under the filter? */
export function isSourceShown(filter: SourceFilter, key: string, ctx: PickerContext): boolean {
  if (filter.sourceMode === 'all') {
    return key === FOLLOWS_SOURCE_KEY ? ctx.followsInEverything : true;
  }
  const covered = coveredBy(filter.sourceKeys, ctx).has(key);
  return filter.sourceMode === 'include' ? covered : !covered;
}

export type CheckState = 'on' | 'off' | 'some';

/** A row's checkbox: a source, a group, or any set of sources (a category). */
export function checkStateOf(
  filter: SourceFilter,
  item: string | readonly string[],
  ctx: PickerContext
): CheckState {
  const members = typeof item === 'string' ? membersOf(item, ctx.groups) : item;
  if (members.length === 0) {
    // An empty group: it reads as whatever the filter says about it by name.
    if (typeof item !== 'string') return 'off';
    if (filter.sourceMode === 'all') return 'on';
    const named = filter.sourceKeys.includes(item);
    return filter.sourceMode === 'include' ? (named ? 'on' : 'off') : named ? 'off' : 'on';
  }
  let on = 0;
  for (const m of members) if (isSourceShown(filter, m, ctx)) on++;
  return on === 0 ? 'off' : on === members.length ? 'on' : 'some';
}

/** Tidy a filter: no key twice, no key a group in it already covers, and an
 *  exclude filter that leaves out only what Everything does becomes Everything. */
export function normalizeSourceFilter(filter: SourceFilter, ctx: PickerContext): SourceFilter {
  if (filter.sourceMode === 'all') return { sourceMode: 'all', sourceKeys: [] };
  const keys = [...new Set(filter.sourceKeys)];
  const groupKeys = keys.filter(isGroupKey);
  const coveredByGroups = coveredBy(groupKeys, ctx);
  const tidy = keys.filter((k) => isGroupKey(k) || !coveredByGroups.has(k));
  if (filter.sourceMode === 'exclude') {
    const base = everythingExclusions(ctx);
    if (tidy.length === base.length && base.every((k) => tidy.includes(k))) {
      return { sourceMode: 'all', sourceKeys: [] };
    }
  }
  return { sourceMode: filter.sourceMode, sourceKeys: tidy };
}

/**
 * Drop `members` from a list of keys. A group that covered any of them is
 * replaced by its other members — the rest stay as they were, though they no
 * longer grow with the group.
 */
function withoutMembers(keys: readonly string[], drop: ReadonlySet<string>, ctx: PickerContext) {
  const out: string[] = [];
  for (const key of keys) {
    if (drop.has(key)) continue;
    if (isGroupKey(key)) {
      const members = ctx.groups.get(key) ?? [];
      if (members.some((m) => drop.has(m))) {
        for (const m of members) if (!drop.has(m)) out.push(m);
        continue;
      }
    }
    out.push(key);
  }
  return out;
}

/**
 * Check or uncheck a row. `item` is a source or group key, or a list of source
 * keys (a category, which has no key of its own).
 */
export function setSourceChecked(
  filter: SourceFilter,
  item: string | readonly string[],
  checked: boolean,
  ctx: PickerContext
): SourceFilter {
  const keys = typeof item === 'string' ? [item] : [...item];
  const members = new Set(keys.flatMap((k) => membersOf(k, ctx.groups)));
  for (const k of keys) members.add(k);

  let { sourceMode, sourceKeys } = filter;
  if (sourceMode === 'all') {
    // Leave Everything for the exclude filter that says the same thing.
    sourceMode = 'exclude';
    sourceKeys = everythingExclusions(ctx);
  }

  const adding = sourceMode === 'include' ? checked : !checked;
  const rest = withoutMembers(sourceKeys, members, ctx);
  return normalizeSourceFilter({ sourceMode, sourceKeys: adding ? [...rest, ...keys] : rest }, ctx);
}

/** Show only this row's sources. */
export function onlySource(item: string | readonly string[]): SourceFilter {
  return { sourceMode: 'include', sourceKeys: typeof item === 'string' ? [item] : [...item] };
}

// --- Folding in the old Type filter ---

/** Bumped when a stored channel filter changes meaning; see upgradeChannelFilter. */
export const CHANNEL_FILTER_VERSION = 2;

const TYPE_GROUPS: [string, string][] = [
  ['email.newsletter', GROUP_NEWSLETTERS],
  ['bsky.likes', GROUP_LIKES],
  ['bsky.bookmarks', GROUP_BOOKMARKS],
];

type UpgradeInput = Pick<
  FilteredView,
  'mode' | 'sourceMode' | 'sourceKeys' | 'typeFilter' | 'autoRule' | 'filterVersion'
>;

export interface UpgradedChannelFilter extends SourceFilter {
  /** Kept only on a smart channel, whose rule recomputes its keys (see `keysOfTypes`). */
  typeFilter?: FilteredView['typeFilter'];
  filterVersion: number;
}

/**
 * A stored channel's filter in today's terms. Channels from before the source
 * groups carry two things this undoes:
 *   - a separate type filter, ANDed with the sources. It becomes group keys:
 *     include the types it named, or exclude the ones it didn't.
 *   - exclude filters that never showed your follows' links. Exclude now means
 *     every source, so those get the follows key added to keep them as they were.
 * A smart channel keeps its type filter, which `syncAutoRuleChannels` applies to
 * the keys its rule produces (they'd otherwise be recomputed without it).
 * Pure; a channel already at CHANNEL_FILTER_VERSION comes back as it is.
 */
export function upgradeChannelFilter(view: UpgradeInput): UpgradedChannelFilter {
  const sourceMode = view.sourceMode ?? 'all';
  const sourceKeys = sourceMode === 'all' ? [] : [...(view.sourceKeys ?? [])];
  if (view.mode === 'saved' || (view.filterVersion ?? 0) >= CHANNEL_FILTER_VERSION) {
    return {
      sourceMode,
      sourceKeys,
      typeFilter: view.autoRule ? view.typeFilter : undefined,
      filterVersion: view.filterVersion ?? CHANNEL_FILTER_VERSION,
    };
  }

  const types = new Set<string>(view.typeFilter ?? []);
  const filterVersion = CHANNEL_FILTER_VERSION;

  if (sourceMode === 'include') {
    // A manual include channel never carried a type (filteredViews cleared it);
    // a smart one keeps it for its rule.
    return {
      sourceMode,
      sourceKeys,
      typeFilter: view.autoRule && types.size > 0 ? view.typeFilter : undefined,
      filterVersion,
    };
  }

  if (types.size === 0) {
    // Exclude never showed your follows' links; say so now that it would.
    const keys =
      sourceMode === 'exclude' && !sourceKeys.includes(FOLLOWS_SOURCE_KEY)
        ? [...sourceKeys, FOLLOWS_SOURCE_KEY]
        : sourceKeys;
    return { sourceMode, sourceKeys: keys, filterVersion };
  }

  const rss = types.has('rss');
  const docs = types.has('atproto.documents');

  // "Only these types" reads best as an include filter, and is one exactly when
  // the types fall on whole groups (feeds and documents together, or neither).
  if (sourceMode === 'all' && rss === docs) {
    const keys = TYPE_GROUPS.filter(([t]) => types.has(t)).map(([, g]) => g);
    if (rss) keys.unshift(GROUP_PUBLICATIONS);
    return { sourceMode: 'include', sourceKeys: keys, filterVersion };
  }

  // Otherwise exclude what the type filter left out. A type filter always hid
  // your follows' links.
  const out = [...sourceKeys];
  for (const [t, g] of TYPE_GROUPS) if (!types.has(t)) out.push(g);
  if (!rss && !docs) out.push(GROUP_PUBLICATIONS);
  else if (!rss) out.push(GROUP_FEEDS);
  else if (!docs) out.push(GROUP_DOCUMENTS);
  if (!out.includes(FOLLOWS_SOURCE_KEY)) out.push(FOLLOWS_SOURCE_KEY);
  return { sourceMode: 'exclude', sourceKeys: out, filterVersion };
}

/** The subscription keys among `keys` whose type a smart channel's old type filter names. */
export function keysOfTypes(
  keys: readonly string[],
  typeFilter: readonly string[] | undefined,
  subscriptions: readonly Subscription[]
): string[] {
  if (!typeFilter || typeFilter.length === 0) return [...keys];
  const allowed = new Set(typeFilter);
  const typeByKey = new Map<string, string>();
  for (const sub of subscriptions) {
    const key = subscriptionSourceKey(sub);
    const group = sourceGroupOf(sub);
    if (!key || !group) continue;
    const type =
      group === GROUP_NEWSLETTERS
        ? 'email.newsletter'
        : group === GROUP_LIKES
          ? 'bsky.likes'
          : group === GROUP_BOOKMARKS
            ? 'bsky.bookmarks'
            : sub.sourceType === 'atproto.documents'
              ? 'atproto.documents'
              : 'rss';
    typeByKey.set(key, type);
  }
  return keys.filter((k) => {
    const type = typeByKey.get(k);
    return type === undefined || allowed.has(type);
  });
}
