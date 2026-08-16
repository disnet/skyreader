// Linkblog write path + cross-device reconciliation.
//
// Sharing an article writes a site.standard.document to the user's portable
// `skyreader-links` publication (backend: /api/linkblog/share). This store keeps
// a local, optimistic record of what's been shared — keyed by the external
// article URL — so the share button reflects shared state and supports
// un-sharing. State is persisted to IndexedDB so it survives reloads.
//
// The local set alone is device-scoped: a share made on another device wouldn't
// light up here. So shared-state is the UNION of the local set and an
// authoritative overlay derived from the user's own pulled linkblog documents
// (`myLinkblogStore`, which now surfaces each link post's external `links`). The
// overlay rebuilds from the server on every linkblog load, so a share made — or
// undone — elsewhere reconciles in. Local mutations that need an rkey to act on
// (note edit, un-share) first materialize the overlay entry into the local set.

import { api } from '$lib/services/api';
import { db } from '$lib/services/db';
import { safeAdd } from '$lib/services/safeDb.svelte';
import { generateTid } from '$lib/utils/tid';
import { myLinkblogStore } from '$lib/stores/myLinkblog.svelte';
import { getExternalArticleLink, getLinkPostNote, isSkyreaderShare } from '$lib/utils/linkPost';
import type { Article, LinkblogShare } from '$lib/types';

function createLinkblogStore() {
  // Keyed by external article URL (the linkblog dedup key).
  let shares = $state<Map<string, LinkblogShare>>(new Map());
  let hasLoaded = false;

  // Authoritative cross-device overlay: the user's own link posts pulled from the
  // proxy, keyed by the external article URL. Rebuilds whenever myLinkblogStore's
  // documents change, so it reflects shares made on any device.
  const serverShares = $derived.by(() => {
    const map = new Map<string, { recordUri: string; note?: string; title?: string }>();
    for (const doc of myLinkblogStore.documents) {
      // Only OUR link posts. A connected publication also lists the posts its home
      // app wrote; treating one of those as a share would make the reader's Share
      // button offer to "un-share" — i.e. delete — someone's own essay.
      if (!isSkyreaderShare(doc)) continue;
      const url = getExternalArticleLink(doc);
      if (url)
        map.set(url, { recordUri: doc.recordUri, note: getLinkPostNote(doc), title: doc.title });
    }
    return map;
  });

  async function load() {
    if (hasLoaded) return;
    hasLoaded = true;
    try {
      const cachedShares = await db.linkblogShares.toArray();
      shares = new Map(cachedShares.map((s) => [s.articleUrl, s]));
    } catch (e) {
      console.error('Failed to load linkblog state from cache:', e);
    }
  }

  function isShared(articleUrl: string): boolean {
    return shares.has(articleUrl) || serverShares.has(articleUrl);
  }

  function getNote(articleUrl: string): string | undefined {
    // Local note wins (it carries this device's just-made edits); fall back to the
    // authoritative overlay for shares made elsewhere.
    return shares.get(articleUrl)?.note ?? serverShares.get(articleUrl)?.note;
  }

  // Prune local shares that the authoritative pull says no longer exist — the
  // cross-device "deleted" signal. Only runs when the pull was COMPLETE (the
  // user's whole document set fit under the proxy cap), so an absent record means
  // deleted, not merely beyond the cap. Scoped to CONFIRMED shares (those with a
  // recordUri): a local-only optimistic share still in flight has no server
  // identity yet and must not be pruned.
  //
  // Deliberately checks EVERY pulled document, not just the marker-gated
  // `serverShares`. Deleting a local row is the destructive direction: an
  // unmarked document pointing at the article (a share written before the marker
  // existed, or one pulled through a proxy that doesn't forward the field yet)
  // is ambiguous, not proof of deletion. Being wrong the other way only leaves a
  // stale "shared" pill until the next pull.
  async function reconcile() {
    if (!myLinkblogStore.lastPullComplete) return;
    const present = new Set(
      myLinkblogStore.documents.map((doc) => getExternalArticleLink(doc)).filter(Boolean)
    );
    const stale: LinkblogShare[] = [];
    for (const entry of shares.values()) {
      if (entry.recordUri && !present.has(entry.articleUrl)) stale.push(entry);
    }
    if (stale.length === 0) return;
    for (const entry of stale) {
      shares.delete(entry.articleUrl);
      if (entry.id !== undefined) await db.linkblogShares.delete(entry.id);
    }
    shares = new Map(shares);
  }

  // Hydrate a local share entry from the authoritative overlay so device-local
  // mutations have an rkey/recordUri to act on. Needed when the share was made on
  // another device and only exists in the pulled documents. Idempotent.
  async function materializeFromOverlay(articleUrl: string): Promise<LinkblogShare | undefined> {
    const existing = shares.get(articleUrl);
    if (existing) return existing;
    const server = serverShares.get(articleUrl);
    const rkey = server?.recordUri.split('/').pop();
    if (!server || !rkey) return undefined;
    const entry: LinkblogShare = {
      rkey,
      recordUri: server.recordUri,
      articleUrl,
      articleTitle: server.title,
      note: server.note,
      createdAt: new Date().toISOString(),
    };
    const id = await safeAdd(db.linkblogShares, entry);
    const stored = id !== undefined ? { ...entry, id } : entry;
    shares.set(articleUrl, stored);
    shares = new Map(shares);
    return stored;
  }

  // Share an article to the linkblog. Optimistically marks it shared, writes the
  // document via the backend, and rolls back the optimistic state on failure.
  // Pass `repostUri` (an at:// link post URI) to make this a quote-reshare — the
  // entry still lives in the user's own linkblog, keyed by the article URL.
  async function shareLink(article: Article, note?: string, repostUri?: string) {
    // Guard against both a local duplicate and one already shared on another
    // device (surfaced via the overlay) — re-sharing would create a second copy.
    if (!article.url || shares.has(article.url) || serverShares.has(article.url)) return;

    const rkey = generateTid();
    const now = new Date().toISOString();
    const entry: LinkblogShare = {
      rkey,
      articleUrl: article.url,
      articleTitle: article.title,
      note,
      createdAt: now,
    };

    // Optimistic insert (local state + cache)
    shares.set(article.url, entry);
    shares = new Map(shares);
    const id = await safeAdd(db.linkblogShares, entry);
    if (id !== undefined) {
      shares.set(article.url, { ...entry, id });
      shares = new Map(shares);
    }

    try {
      const result = await api.createLinkblogShare({
        rkey,
        articleUrl: article.url,
        articleTitle: article.title,
        articleAuthor: article.author,
        excerpt: article.summary,
        articleImage: article.imageUrl,
        articlePublishedAt: article.publishedAt,
        note,
        repostUri,
      });
      const stored = shares.get(article.url);
      if (stored) {
        stored.recordUri = result.uri;
        if (stored.id !== undefined) {
          await db.linkblogShares.update(stored.id, { recordUri: result.uri });
        }
      }
      // Surface the share on the user's own linkblog right away, ahead of the
      // pull path's indexing lag (the "it wasn't there yet" gap).
      myLinkblogStore.addOptimistic({
        recordUri: result.uri,
        siteUri: result.publication,
        articleUrl: article.url,
        articleTitle: article.title,
        publishedAt: article.publishedAt,
        note,
        createdAt: now,
      });
    } catch (e) {
      // Roll back the optimistic insert — the share didn't land.
      console.error('Failed to write linkblog share:', e);
      const stored = shares.get(article.url);
      shares.delete(article.url);
      shares = new Map(shares);
      if (stored?.id !== undefined) {
        await db.linkblogShares.delete(stored.id);
      }
      myLinkblogStore.removeByArticleUrl(article.url);
      // Already handled: optimistic state rolled back, and a scope-upgrade
      // failure surfaces the global "log in again" banner via the api client.
      // Don't rethrow — this runs from an onclick handler.
    }
  }

  // Set (or clear, with '') the note on an already-shared article. Optimistically
  // updates local state + cache, PATCHes the PDS document, and rolls back on
  // failure. No-op if the article isn't shared yet (locally or on another device).
  async function setNote(articleUrl: string, note: string) {
    const existing = await materializeFromOverlay(articleUrl);
    if (!existing) return;

    const next = note.trim() || undefined;
    const prevNote = existing.note;
    if (next === prevNote) return;

    // Optimistic update (local state + cache)
    shares.set(articleUrl, { ...existing, note: next });
    shares = new Map(shares);
    if (existing.id !== undefined) {
      await db.linkblogShares.update(existing.id, { note: next });
    }
    // Keep the user's own linkblog list (and the overlay derived from it) in sync
    // — without this, a note edited after sharing stays stale on /linkblog until
    // the next pull replaces the optimistic document.
    if (existing.recordUri) myLinkblogStore.setNote(existing.recordUri, next ?? '');

    try {
      await api.updateLinkblogShareNote(existing.rkey, next ?? '');
    } catch (e) {
      // Roll back — the note didn't land.
      console.error('Failed to update linkblog note:', e);
      const cur = shares.get(articleUrl);
      if (cur) {
        shares.set(articleUrl, { ...cur, note: prevNote });
        shares = new Map(shares);
        if (cur.id !== undefined) {
          await db.linkblogShares.update(cur.id, { note: prevNote });
        }
      }
      if (existing.recordUri) myLinkblogStore.setNote(existing.recordUri, prevNote ?? '');
    }
  }

  async function unshare(articleUrl: string) {
    // Materialize a cross-device share so we have its rkey to delete.
    const existing = await materializeFromOverlay(articleUrl);
    if (!existing) return;

    // Optimistic remove
    shares.delete(articleUrl);
    shares = new Map(shares);
    if (existing.id !== undefined) {
      await db.linkblogShares.delete(existing.id);
    }
    myLinkblogStore.removeByArticleUrl(articleUrl);

    try {
      await api.deleteLinkblogShare(existing.rkey);
    } catch (e) {
      // Roll back — the delete didn't land, so keep showing it as shared.
      console.error('Failed to delete linkblog share:', e);
      const restored = { ...existing };
      delete restored.id;
      const id = await safeAdd(db.linkblogShares, restored);
      shares.set(articleUrl, id !== undefined ? { ...restored, id } : restored);
      shares = new Map(shares);
      // The pull path will re-surface the still-present PDS document on the next
      // linkblog load; no optimistic re-insert needed here.
    }
  }

  return {
    load,
    reconcile,
    isShared,
    getNote,
    shareLink,
    setNote,
    unshare,
  };
}

export const linkblogStore = createLinkblogStore();
