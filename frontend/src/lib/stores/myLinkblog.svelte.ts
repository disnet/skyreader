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

  async function load(force = false) {
    if ((loaded || loading) && !force) return;
    const user = auth.user;
    if (!user) return;

    loading = true;
    error = null;
    try {
      const [pub, batch] = await Promise.all([
        api.getLinkblogPublication().catch(() => null),
        api.fetchDocumentsBatchV2([{ did: user.did, siteUri: publicationUri(user.did) }]),
      ]);
      publication = pub;
      const author = batch.authors[0];
      documents = author?.status === 'ready' ? author.documents : [];
      if (author?.status === 'error') {
        error = author.error ?? 'Could not load your linkblog.';
      }
      loaded = true;
    } catch (e) {
      error = e instanceof Error ? e.message : 'Could not load your linkblog.';
    } finally {
      loading = false;
    }
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
    load,
    publicUrl,
    removeByRecordUri,
  };
}

export const myLinkblogStore = createMyLinkblogStore();
