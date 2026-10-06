// Whether a feed article is an emailed newsletter issue, and the one gate every
// surface goes through before a web extraction may stand in for its body. Lives
// apart from utils/newsletters.ts because it reads the subscriptions store and
// IndexedDB, and that module is imported by `$lib/types` (no store imports there).
//
// A newsletter's body *is* the article: the mail is the canonical copy, and its
// web link (if any) is a teaser, a paywall or a different free/paid cut. So no
// web extraction replaces it — except when the archive confirms the mail itself
// is gone, and then only one the reader asked for ("Fetch full article", Shift+F).
import { untrack } from 'svelte';
import { SvelteMap, SvelteSet } from 'svelte/reactivity';
import { db } from '$lib/services/db';
import { subscriptionsStore } from '$lib/stores/subscriptions.svelte';
import { linkPostContentStore } from '$lib/stores/linkPostContent.svelte';
import type { Subscription } from '$lib/types';
import { isNewsletterSubscription } from './newsletters';

/**
 * The subscription behind an article, from memory or — before the store has
 * hydrated (a cold `?read=` deep link) — from IndexedDB.
 */
export async function resolveSubscription(
  subscriptionId: number | null | undefined
): Promise<Subscription | undefined> {
  if (subscriptionId == null) return undefined;
  const sub = subscriptionsStore.getById(subscriptionId);
  if (sub) return sub;
  try {
    return await db.subscriptions.get(subscriptionId);
  } catch {
    return undefined;
  }
}

/** Whether an article is a newsletter's, waiting on IndexedDB if the store is still loading. */
export async function resolveIsNewsletterFeedItem(
  subscriptionId: number | null | undefined
): Promise<boolean> {
  const sub = await resolveSubscription(subscriptionId);
  return sub ? isNewsletterSubscription(sub) : false;
}

// IndexedDB answers for subscriptions the in-memory store doesn't hold (yet).
const resolvedFromDb = new SvelteMap<number, boolean>();
const resolving = new Set<number>();

/**
 * Reactive answer: true/false, or undefined while it's still being looked up
 * (the subscriptions store hasn't hydrated). Callers that would let a web copy
 * stand in for the body treat undefined as "not yet" — a wrong "no" would show
 * a newsletter's paywalled web cut in place of the mail.
 */
export function newsletterStatus(subscriptionId: number | null | undefined): boolean | undefined {
  if (subscriptionId == null) return false;
  const sub = subscriptionsStore.getById(subscriptionId);
  if (sub) return isNewsletterSubscription(sub);
  const known = resolvedFromDb.get(subscriptionId);
  if (known !== undefined) return known;
  if (!resolving.has(subscriptionId)) {
    resolving.add(subscriptionId);
    void resolveIsNewsletterFeedItem(subscriptionId)
      .then((v) => resolvedFromDb.set(subscriptionId, v))
      .finally(() => resolving.delete(subscriptionId));
  }
  return undefined;
}

/** Reactive: whether the article is known to be a newsletter's. */
export function isNewsletterFeedItem(subscriptionId: number | null | undefined): boolean {
  return newsletterStatus(subscriptionId) === true;
}

// Newsletter issues (by guid) whose mail the archive confirmed is gone: no row
// body, no stored copy. Only these may take a web copy, and only one asked for.
const mailMissing = new SvelteSet<string>();

export function markNewsletterMailMissing(guid: string | null | undefined): void {
  // Untracked: called from effects, which mustn't come to depend on the set.
  untrack(() => {
    if (guid && !mailMissing.has(guid)) mailMissing.add(guid);
  });
}

interface FeedArticleRef {
  url?: string | null;
  guid?: string | null;
  subscriptionId?: number | null;
}

/**
 * Reactive: whether a web extraction of the article's link may stand in for its
 * body — on render as much as on fetch, so a cached extraction (a followed user
 * shared the issue) never shows in place of a newsletter's mail.
 */
export function webCopyAllowed(item: FeedArticleRef): boolean {
  const status = newsletterStatus(item.subscriptionId);
  return status === false || (status === true && !!item.guid && mailMissing.has(item.guid));
}

/**
 * The gate in front of every web extraction of a feed article's link. `asked`:
 * the reader explicitly asked (⋯ menu, Shift+F) — allowed for a newsletter only
 * once its mail is confirmed gone; automatic fetches never extract a newsletter.
 * Resolves whether the fetch was started.
 */
export async function fetchArticleWebCopy(
  item: FeedArticleRef,
  { asked }: { asked: boolean }
): Promise<boolean> {
  const url = item.url;
  if (!url) return false;
  // Untracked: callers run inside effects, and the store's reactive reads (the
  // subscription, the extract cache's entry map) must not become dependencies.
  const newsletter = await untrack(() => resolveIsNewsletterFeedItem(item.subscriptionId));
  if (newsletter && !(asked && item.guid && mailMissing.has(item.guid))) return false;
  untrack(() => void linkPostContentStore.fetch(url));
  return true;
}
