// What Skyreader does when the workspace shell hands it something: open a
// standard.site document, or run one of the actions it offers other apps.

import { goto } from '$app/navigation';
import { ScopeUpgradeError, SubscriptionLimitError, UrlSaveLimitError } from '$lib/services/api';
import { savesStore } from '$lib/stores/saves.svelte';
import { subscriptionsStore } from '$lib/stores/subscriptions.svelte';
import { toastStore } from '$lib/stores/toast.svelte';
import { fetchCollectionDoc } from '$lib/utils/collectionPiece';
import { getDisplayContent } from '$lib/utils/displayItem';
import { readerUrl } from '$lib/utils/readerLink';
import { collectionOf, repoOf, type WorkspaceItem } from './protocol';

export const DOCUMENT = 'site.standard.document';
export const PUBLICATION = 'site.standard.publication';

/** Collections the shell may send `open` for (the `handles` in `hello`). */
export const HANDLES = [DOCUMENT];

/** What other apps can hand Skyreader (the `actions` in `hello`). */
export const ACTIONS = [
  { id: 'save', label: 'Save to Skyreader', accepts: ['url', DOCUMENT] },
  { id: 'follow', label: 'Follow in Skyreader', accepts: [PUBLICATION] },
];

// Surfaces that host a reader stack, so `?read=` opens the item over them.
const READER_SURFACES = ['/home', '/feeds', '/saved'];

/**
 * Open a document in the reader. Rides the reader's own URL contract
 * (`?read=<at:// uri>`, $lib/utils/readerLink): a document no store holds is
 * fetched, since documents are public.
 */
export async function openDocument(uri: string): Promise<void> {
  if (collectionOf(uri) !== DOCUMENT) return;
  const here = new URL(location.href);
  const base = READER_SURFACES.includes(here.pathname) ? here : new URL('/home', location.origin);
  await goto(readerUrl(base, uri));
}

/** Run action `id` on `item`. The caller has checked the account. */
export async function perform(id: string, item: WorkspaceItem): Promise<void> {
  if (id === 'save') return save(item);
  if (id === 'follow') return follow(item);
}

async function save(item: WorkspaceItem): Promise<void> {
  const doc = item.uri && collectionOf(item.uri) === DOCUMENT ? item.uri : null;
  if (!doc && !item.url) return;
  const existing = (doc && savesStore.find(doc)) || (item.url && savesStore.find(item.url));
  if (existing) {
    toastStore.update(toastStore.add('Already saved'), 'success');
    return;
  }

  const toast = toastStore.add('Saving…');
  try {
    if (doc) await saveDocument(doc, item);
    else await savesStore.saveFromUrl(item.url!, { title: item.title || undefined });
    toastStore.update(toast, 'success', 'Saved to Skyreader');
  } catch (err) {
    toastStore.update(toast, 'error', failure(err, 'Could not save that'));
  }
}

// A document renders from its record, not from its page: save it as one, with
// the body the reader would show (as a curated piece is saved).
async function saveDocument(uri: string, item: WorkspaceItem): Promise<void> {
  const fetched = await fetchCollectionDoc(uri).catch(() => null);
  await savesStore.saveDocument({
    recordUri: uri,
    url: fetched?.canonicalUrl || fetched?.path || item.url || '',
    title: fetched?.title || item.title || undefined,
    description: fetched?.description,
    publishedAt: fetched?.publishedAt,
    content: fetched
      ? getDisplayContent({ type: 'document', item: fetched, key: uri }) || undefined
      : undefined,
  });
}

async function follow(item: WorkspaceItem): Promise<void> {
  const uri = item.uri;
  if (!uri || collectionOf(uri) !== PUBLICATION) return;
  const did = repoOf(uri);
  if (!did.startsWith('did:')) return;
  if (subscriptionsStore.subscriptions.some((s) => s.feedUrl === uri)) {
    toastStore.update(toastStore.add('Already following'), 'success');
    return;
  }

  const toast = toastStore.add('Following…');
  try {
    await subscriptionsStore.add(uri, item.title, {
      sourceType: 'atproto.documents',
      subjectDid: did,
      siteUrl: item.url,
      feedUrl: uri,
    });
    toastStore.update(toast, 'success', `Following ${item.title}`);
  } catch (err) {
    toastStore.update(toast, 'error', failure(err, 'Could not follow that'));
  }
}

function failure(err: unknown, fallback: string): string {
  if (err instanceof UrlSaveLimitError) return 'You’ve reached today’s save limit';
  if (err instanceof SubscriptionLimitError) return 'You’ve reached your feed limit';
  if (err instanceof ScopeUpgradeError) return 'Open Skyreader in its own tab to allow that first';
  return err instanceof Error && err.message ? err.message : fallback;
}
