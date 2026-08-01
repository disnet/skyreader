// "My Linkblog" page state.
//
// Loads the current user's own portable linkblog: the `skyreader-links`
// publication metadata plus the `site.standard.document` records the user has
// shared, pulled (newest-first) from the feed proxy scoped to that publication.
// This is the same pull path the public linkblog site (linkblogs.skyreader.app)
// uses, so it reflects what's actually in the user's PDS — not just this session's
// optimistic shares.

import { api } from '$lib/services/api';
import { auth } from '$lib/stores/auth.svelte';
import { getExternalArticleLink } from '$lib/utils/linkPost';
import { noteToLeafletBlocks } from '$lib/utils/linkPostNote';
import { loadDigests, saveDigests, scopeKey } from '$lib/services/documentDigests';
import type { LinkblogPublication, SocialDocument } from '$lib/types';

const PUBLICATION_COLLECTION = 'site.standard.publication';
const LINKBLOG_RKEY = 'skyreader-links';

function publicationUri(did: string): string {
  return `at://${did}/${PUBLICATION_COLLECTION}/${LINKBLOG_RKEY}`;
}

function createMyLinkblogStore() {
  let documents = $state<SocialDocument[]>([]);
  let publication = $state<LinkblogPublication | null>(null);
  let loading = $state(false);
  let loaded = $state(false);
  let error = $state<string | null>(null);
  // Whether the last successful pull returned the user's COMPLETE document set
  // (fit under the proxy's per-author cap). When true, a share absent from the
  // pull was deleted — not merely beyond the cap — so consumers can safely prune.
  let lastPullComplete = $state(false);
  // recordUris of locally-inserted optimistic shares the pull path hasn't
  // surfaced yet. Kept across loads (the proxy lags the PDS write by an indexing
  // round-trip) and retired once the real document arrives.
  let optimisticUris = new Set<string>();

  async function load(force = false) {
    if ((loaded || loading) && !force) return;
    const user = auth.user;
    if (!user) return;

    loading = true;
    error = null;
    try {
      const siteUri = publicationUri(user.did);
      // Echo the per-scope content digest so an unchanged linkblog short-circuits
      // (bodyless `unchanged`) instead of re-downloading the full set every forced
      // refresh. Only send it when we already hold an in-memory set to keep on a
      // match: this list is memory-only (no IndexedDB hydration), so it resets to []
      // on a page reload — sending a digest on that first empty load would let an
      // `unchanged` response render the linkblog blank. With a non-empty set in
      // hand, `unchanged` safely means "keep exactly what's shown."
      const digests = loadDigests();
      const key = scopeKey(user.did, siteUri);
      const since_digest = documents.length > 0 ? digests[key] : undefined;

      const [pub, batch] = await Promise.all([
        api.getLinkblogPublication().catch(() => null),
        api.fetchDocumentsBatchV2([
          { did: user.did, siteUri, ...(since_digest ? { since_digest } : {}) },
        ]),
      ]);
      publication = pub;
      const author = batch.authors[0];

      // Unchanged: nothing changed upstream since the digest we sent, so keep the
      // current documents, their optimistic carry-forward, and `lastPullComplete`
      // exactly as-is. (Reached only when documents was non-empty, so there is a
      // real set to preserve.)
      if (author?.status === 'unchanged') {
        loaded = true;
        return;
      }

      const fetched = author?.status === 'ready' ? (author.documents ?? []) : [];
      // Carry forward optimistic shares the pull path hasn't indexed yet, deduped
      // by external article link, so a just-shared link doesn't vanish on the
      // first load of the linkblog view. Retire ones that have now arrived.
      const fetchedLinks = new Set(fetched.map((d) => getExternalArticleLink(d)).filter(Boolean));
      const stillPending = documents.filter(
        (d) => optimisticUris.has(d.recordUri) && !fetchedLinks.has(getExternalArticleLink(d))
      );
      optimisticUris = new Set(stillPending.map((d) => d.recordUri));
      documents = [...stillPending, ...fetched];
      lastPullComplete = author?.status === 'ready' && author.complete === true;
      // Store the new digest for this scope so the next forced refresh can
      // short-circuit. Kept regardless of `complete`: a capped set still hashes its
      // live window, and `lastPullComplete` is preserved verbatim on `unchanged`.
      if (author?.status === 'ready' && author.digest) {
        digests[key] = author.digest;
        saveDigests(digests);
      }
      if (author?.status === 'error') {
        error = author.error ?? 'Could not load your linkblog.';
      }
      loaded = true;
    } catch (e) {
      error = e instanceof Error ? e.message : 'Could not load your linkblog.';
      lastPullComplete = false;
    } finally {
      loading = false;
    }
  }

  // Front-insert a just-shared link so it shows on the user's own linkblog
  // immediately, ahead of the PDS → indexer → proxy round-trip. Built to match
  // what the link-post card reads: the external URL in `links`, the note as the
  // leading native Leaflet note blocks. Deduped by article URL.
  function addOptimistic(input: {
    recordUri: string;
    siteUri: string;
    articleUrl: string;
    articleTitle?: string;
    publishedAt?: string;
    note?: string;
    createdAt: string;
  }) {
    const did = auth.user?.did;
    if (!did) return;
    const note = input.note?.trim();
    const doc: SocialDocument = {
      authorDid: did,
      recordUri: input.recordUri,
      siteUri: input.siteUri,
      title: input.articleTitle || input.articleUrl,
      publishedAt: input.publishedAt || input.createdAt,
      createdAt: input.createdAt,
      // New shares carry the quote inside the note (the body), not a top-level
      // `description` — leaving it unset so this optimistic doc renders exactly
      // like the pulled one (no standalone legacy quote, just the note body).
      description: undefined,
      links: [{ uri: input.articleUrl, rel: 'related' }],
      content: note
        ? {
            $type: 'pub.leaflet.content',
            pages: [
              {
                $type: 'pub.leaflet.pages.linearDocument',
                blocks: noteToLeafletBlocks(note),
              },
            ],
          }
        : undefined,
    };
    optimisticUris.add(doc.recordUri);
    documents = [doc, ...documents.filter((d) => getExternalArticleLink(d) !== input.articleUrl)];
  }

  // Rebuild a document's pub.leaflet body with new leading text/blockquote
  // blocks, preserving the website card and everything after it.
  function rebuildContentWithNote(existing: unknown, note: string): unknown {
    const pages =
      (existing as { pages?: Array<{ blocks?: Array<{ block?: { $type?: string } }> }> })?.pages ??
      [];
    const blocks: Array<{ block: unknown }> = [];
    blocks.push(...noteToLeafletBlocks(note));
    const oldBlocks = pages[0]?.blocks ?? [];
    const firstPreserved = oldBlocks.findIndex(
      (wrapper) =>
        wrapper.block?.$type !== 'pub.leaflet.blocks.text' &&
        wrapper.block?.$type !== 'pub.leaflet.blocks.blockquote'
    );
    if (firstPreserved >= 0) {
      for (const wrapper of oldBlocks.slice(firstPreserved)) {
        if (wrapper.block) blocks.push({ block: wrapper.block });
      }
    }
    if (blocks.length === 0) return undefined;
    return {
      $type: 'pub.leaflet.content',
      pages: [{ $type: 'pub.leaflet.pages.linearDocument', blocks }],
    };
  }

  // Update the note on an already-listed document (keyed by record URI), so the
  // "My Linkblog" page and the cross-device overlay reflect a note edit right
  // away — the edit paths PATCH the PDS but the pull that would otherwise refresh
  // this list lags behind. No-op if the document isn't currently listed.
  function setNote(recordUri: string, note: string) {
    const idx = documents.findIndex((d) => d.recordUri === recordUri);
    if (idx === -1) return;
    const doc = documents[idx];
    const next: SocialDocument = {
      ...doc,
      content: rebuildContentWithNote(doc.content, note.trim()),
    };
    documents = [...documents.slice(0, idx), next, ...documents.slice(idx + 1)];
  }

  // Drop an optimistic (or loaded) share by the external article URL it points
  // at — used to keep the view in sync when a share is undone.
  function removeByArticleUrl(articleUrl: string) {
    documents = documents.filter((d) => getExternalArticleLink(d) !== articleUrl);
    optimisticUris = new Set(
      [...optimisticUris].filter((uri) => documents.some((d) => d.recordUri === uri))
    );
  }

  // The public, logged-out page for this linkblog. The publication's canonical
  // `url` is DID-based and stable (now <linkblogs origin>/<did>/); we present the
  // prettier handle alias (<linkblogs origin>/<handle>/, which 302-redirects to
  // the DID) on the same origin. Falls back to the canonical URL.
  function publicUrl(): string | null {
    const user = auth.user;
    if (!publication || !user) return null;
    try {
      const origin = new URL(publication.url).origin;
      return `${origin}/${user.handle}/`;
    } catch {
      return publication.url;
    }
  }

  // Drop a document locally after the user deletes it from their linkblog.
  function removeByRecordUri(recordUri: string) {
    documents = documents.filter((d) => d.recordUri !== recordUri);
  }

  return {
    get documents() {
      return documents;
    },
    get publication() {
      return publication;
    },
    get loading() {
      return loading;
    },
    get loaded() {
      return loaded;
    },
    get error() {
      return error;
    },
    get lastPullComplete() {
      return lastPullComplete;
    },
    load,
    publicUrl,
    removeByRecordUri,
    addOptimistic,
    setNote,
    removeByArticleUrl,
  };
}

export const myLinkblogStore = createMyLinkblogStore();
