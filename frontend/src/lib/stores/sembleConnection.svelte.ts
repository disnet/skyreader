// Drawing a Semble connection — a typed edge from the article you're reading to
// another URL — as one global session.
//
// Deliberately the same architecture as integrationSave: a store here, a dialog
// mounted once in AppShell, so any reading surface can open it without threading
// props. What differs is the write path.
//
// Online-only, no offline queue. A connection is a deliberate act on the context
// in front of the reader — unlike a card save there's nothing to reconcile later,
// and queueing would add sync-queue surface for a write nobody makes blind. A
// failure keeps the toast and invites a retry.
//
// Semble's own API dedupes identical edges; a direct PDS write doesn't, so a
// double-click would mint two records. `submitting` is what stops that.
import { api, ScopeUpgradeError } from '$lib/services/api';
import { auth } from '$lib/stores/auth.svelte';
import { toastStore } from '$lib/stores/toast.svelte';
import { mentionLaneItemsStore } from '$lib/stores/mentionLaneItems.svelte';
import { sembleCardUrl, sembleSourceUrl } from '$lib/utils/semble';
import type { SembleConnectionType } from '$lib/types';

export interface SembleConnectionSource {
  /** The article the reader is on — the fixed end of the edge. */
  url: string;
  title?: string;
  /** This URL's card page on semble.so, when the panel already resolved one. */
  cardUrl?: string | null;
}

export interface SembleConnectionSubmission {
  /** The other end: pasted, or picked out of the reader's Saved list. */
  targetUrl: string;
  targetTitle?: string;
  connectionType: SembleConnectionType;
  note?: string;
  /** True when the reader flipped the arrow, making the target the source. */
  reversed: boolean;
}

function createSembleConnectionStore() {
  let open = $state(false);
  let submitting = $state(false);
  let source = $state<SembleConnectionSource | null>(null);

  function openFor(data: SembleConnectionSource) {
    if (!data.url) return;
    source = data;
    open = true;
  }

  function close() {
    if (submitting) return;
    open = false;
    source = null;
  }

  async function submit(input: SembleConnectionSubmission) {
    if (submitting) return;
    const article = source;
    if (!article) return;

    // Semble keys cards by the exact URL string, so the variant its card page
    // holds ("/post" vs "/post/") is the one an edge has to name if it's going
    // to roll up onto that page. When the panel gave us a cardUrl, it is
    // literally that variant, encoded — prefer it over our own copy.
    const articleUrl = sembleSourceUrl(article.cardUrl, article.url);
    const from = input.reversed ? input.targetUrl : articleUrl;
    const to = input.reversed ? articleUrl : input.targetUrl;

    submitting = true;
    const toastId = toastStore.add('Connecting on Semble…');
    try {
      const result = await api.createSembleConnection({
        source: from,
        target: to,
        connectionType: input.connectionType,
        note: input.note?.trim() || undefined,
      });

      // Semble's AppView won't serve this edge back for a while (firehose index
      // + the proxy's mention cache), so put it in the panel ourselves rather
      // than leave the reader looking at a list their own act isn't in.
      echoIntoPanel(article.url, input, result.uri);

      open = false;
      source = null;
      toastStore.update(toastId, 'success', 'Connected on Semble', {
        label: 'View',
        href: article.cardUrl || sembleCardUrl(article.url) || undefined,
      });
    } catch (err) {
      // The global banner already says "log in again" — a second, vaguer copy of
      // the same news in a toast is noise.
      if (err instanceof ScopeUpgradeError) {
        toastStore.remove(toastId);
        open = false;
        source = null;
        return;
      }
      console.error('Failed to create Semble connection:', err);
      const message = err instanceof Error ? err.message : 'Please try again';
      toastStore.update(toastId, 'error', `Couldn't connect on Semble — ${message}`);
    } finally {
      submitting = false;
    }
  }

  /** Prepend the reader's own new edge into the article's resolved Semble block. */
  function echoIntoPanel(articleUrl: string, input: SembleConnectionSubmission, uri: string) {
    const user = auth.user;
    if (!user) return;
    mentionLaneItemsStore.addSembleConnection(articleUrl, {
      id: uri,
      // Direction is read from the article's side: an unreversed edge points out
      // of what the reader is on.
      direction: input.reversed ? 'in' : 'out',
      type: input.connectionType.toLowerCase().replace(/_/g, ' '),
      note: input.note?.trim() || null,
      curator: {
        did: user.did,
        handle: user.handle,
        name: user.displayName ?? null,
        avatarUrl: user.avatarUrl ?? null,
      },
      createdAt: new Date().toISOString(),
      other: {
        url: input.targetUrl,
        title: input.targetTitle ?? null,
        description: null,
        siteName: null,
        imageUrl: null,
      },
    });
  }

  return {
    get open() {
      return open;
    },
    get submitting() {
      return submitting;
    },
    /** The article the dialog is open for — the fixed end of the edge. */
    get source() {
      return source;
    },
    /** Open the dialog with `data` as the fixed end of the edge. */
    openFor,
    close,
    submit,
  };
}

export const sembleConnectionStore = createSembleConnectionStore();
