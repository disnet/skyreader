// Linkblog write path (Phase 1).
//
// Sharing an article writes a site.standard.document to the user's portable
// `skyreader-links` publication (backend: /api/linkblog/share). This store keeps
// a local, optimistic record of what's been shared — keyed by the external
// article URL — so the share button reflects shared state and supports
// un-sharing. State is persisted to IndexedDB so it survives reloads.
//
// In Phase 1 the in-app feed doesn't yet read these documents back (that's
// Phase 2's pull-model work), so this local set is the source of truth for the
// button. It can drift if the user shares from another device; Phase 2 adds
// authoritative reconciliation once the proxy surfaces the document `links`.

import { api } from '$lib/services/api';
import { db } from '$lib/services/db';
import { safeAdd } from '$lib/services/safeDb.svelte';
import { generateTid } from '$lib/utils/tid';
import type { Article, LinkblogBoost, LinkblogShare } from '$lib/types';

function createLinkblogStore() {
  // Keyed by external article URL (the linkblog dedup key).
  let shares = $state<Map<string, LinkblogShare>>(new Map());
  // Boosts (bare recommends) keyed by the boosted document's record URI.
  let boosts = $state<Map<string, LinkblogBoost>>(new Map());
  let hasLoaded = false;

  async function load() {
    if (hasLoaded) return;
    hasLoaded = true;
    try {
      const [cachedShares, cachedBoosts] = await Promise.all([
        db.linkblogShares.toArray(),
        db.linkblogBoosts.toArray(),
      ]);
      shares = new Map(cachedShares.map((s) => [s.articleUrl, s]));
      boosts = new Map(cachedBoosts.map((b) => [b.documentUri, b]));
    } catch (e) {
      console.error('Failed to load linkblog state from cache:', e);
    }
  }

  function isShared(articleUrl: string): boolean {
    return shares.has(articleUrl);
  }

  function getNote(articleUrl: string): string | undefined {
    return shares.get(articleUrl)?.note;
  }

  function isBoosted(documentUri: string): boolean {
    return boosts.has(documentUri);
  }

  // Share an article to the linkblog. Optimistically marks it shared, writes the
  // document via the backend, and rolls back the optimistic state on failure.
  // Pass `repostUri` (an at:// link post URI) to make this a quote-reshare — the
  // entry still lives in the user's own linkblog, keyed by the article URL.
  async function shareLink(article: Article, note?: string, repostUri?: string) {
    if (!article.url || shares.has(article.url)) return;

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
    } catch (e) {
      // Roll back the optimistic insert — the share didn't land.
      console.error('Failed to write linkblog share:', e);
      const stored = shares.get(article.url);
      shares.delete(article.url);
      shares = new Map(shares);
      if (stored?.id !== undefined) {
        await db.linkblogShares.delete(stored.id);
      }
      // Already handled: optimistic state rolled back, and a scope-upgrade
      // failure surfaces the global "log in again" banner via the api client.
      // Don't rethrow — this runs from an onclick handler.
    }
  }

  async function unshare(articleUrl: string) {
    const existing = shares.get(articleUrl);
    if (!existing) return;

    // Optimistic remove
    shares.delete(articleUrl);
    shares = new Map(shares);
    if (existing.id !== undefined) {
      await db.linkblogShares.delete(existing.id);
    }

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
      // Not rethrown — restored optimistically; see note in shareLink.
    }
  }

  // Boost (bare recommend) a link post. Optimistically marks it boosted, writes
  // the recommend via the backend, and rolls back on failure.
  async function boost(documentUri: string) {
    if (!documentUri || boosts.has(documentUri)) return;

    const rkey = generateTid();
    const entry: LinkblogBoost = {
      rkey,
      documentUri,
      createdAt: new Date().toISOString(),
    };

    // Optimistic insert (local state + cache)
    boosts.set(documentUri, entry);
    boosts = new Map(boosts);
    const id = await safeAdd(db.linkblogBoosts, entry);
    if (id !== undefined) {
      boosts.set(documentUri, { ...entry, id });
      boosts = new Map(boosts);
    }

    try {
      const result = await api.createBoost({ rkey, document: documentUri });
      const stored = boosts.get(documentUri);
      if (stored) {
        stored.recordUri = result.uri;
        if (stored.id !== undefined) {
          await db.linkblogBoosts.update(stored.id, { recordUri: result.uri });
        }
      }
    } catch (e) {
      // Roll back the optimistic insert — the boost didn't land.
      console.error('Failed to write boost:', e);
      const stored = boosts.get(documentUri);
      boosts.delete(documentUri);
      boosts = new Map(boosts);
      if (stored?.id !== undefined) {
        await db.linkblogBoosts.delete(stored.id);
      }
      // Not rethrown — runs from an onclick handler; scope errors surface globally.
    }
  }

  async function unboost(documentUri: string) {
    const existing = boosts.get(documentUri);
    if (!existing) return;

    // Optimistic remove
    boosts.delete(documentUri);
    boosts = new Map(boosts);
    if (existing.id !== undefined) {
      await db.linkblogBoosts.delete(existing.id);
    }

    try {
      await api.deleteBoost(existing.rkey);
    } catch (e) {
      // Roll back — the delete didn't land, so keep showing it as boosted.
      console.error('Failed to delete boost:', e);
      const restored = { ...existing };
      delete restored.id;
      const id = await safeAdd(db.linkblogBoosts, restored);
      boosts.set(documentUri, id !== undefined ? { ...restored, id } : restored);
      boosts = new Map(boosts);
    }
  }

  return {
    load,
    isShared,
    getNote,
    isBoosted,
    shareLink,
    unshare,
    boost,
    unboost,
  };
}

export const linkblogStore = createLinkblogStore();
