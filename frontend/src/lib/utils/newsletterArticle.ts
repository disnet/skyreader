// Whether a feed article is an emailed newsletter issue. Lives apart from
// utils/newsletters.ts because it reads the subscriptions store and IndexedDB,
// and that module is imported by `$lib/types` (no store imports there).
//
// A newsletter's body *is* the article: the mail is the canonical copy, and its
// web link (if any) is a teaser, a paywall or a different free/paid cut. So
// every surface that would swap a feed body for a web extraction asks this
// first.
import { db } from '$lib/services/db';
import { subscriptionsStore } from '$lib/stores/subscriptions.svelte';
import type { Subscription } from '$lib/types';
import { isEmailBody, isNewsletterSubscription, wrapEmailBody } from './newsletters';

/**
 * Reactive, in-memory answer. False while the subscriptions store hasn't
 * loaded yet — where a wrong "no" would cost an extraction (or a save of the
 * web copy), use `resolveIsNewsletterFeedItem` instead.
 */
export function isNewsletterFeedItem(subscriptionId: number | null | undefined): boolean {
  if (subscriptionId == null) return false;
  const sub = subscriptionsStore.getById(subscriptionId);
  return sub ? isNewsletterSubscription(sub) : false;
}

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

/** `isNewsletterFeedItem` that doesn't answer "no" just because the store is still loading. */
export async function resolveIsNewsletterFeedItem(
  subscriptionId: number | null | undefined
): Promise<boolean> {
  const sub = await resolveSubscription(subscriptionId);
  return sub ? isNewsletterSubscription(sub) : false;
}

/**
 * A save's body, in the email-body scope when the save is of a newsletter issue.
 * Saves made since ingest started wrapping already carry it; older ones don't,
 * and a save row doesn't say where it came from — only its guid, which a feed
 * save shares with the archive row (and so its subscription). A save whose feed
 * row has since been pruned renders unwrapped, as before.
 */
export async function savedBodyWithEmailScope(
  save: { itemGuid?: string },
  content: string | null
): Promise<string | null> {
  if (!content || isEmailBody(content) || !save.itemGuid) return content;
  try {
    const row = await db.articles.where('guid').equals(save.itemGuid).first();
    if (row && (await resolveIsNewsletterFeedItem(row.subscriptionId))) {
      return wrapEmailBody(content);
    }
  } catch {
    // Best effort — render the body as stored.
  }
  return content;
}
