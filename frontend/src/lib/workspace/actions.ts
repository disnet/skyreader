// What Skyreader does when the workspace shell hands it something: open a
// standard.site document, or run one of the actions it offers other apps.

import { goto } from '$app/navigation';
import { ScopeUpgradeError, SubscriptionLimitError, UrlSaveLimitError } from '$lib/services/api';
import { fetchAllDocuments } from '$lib/services/feedFetcher';
import { savesStore } from '$lib/stores/saves.svelte';
import { subscriptionsStore } from '$lib/stores/subscriptions.svelte';
import { toastStore } from '$lib/stores/toast.svelte';
import { documentSave } from '$lib/utils/collectionPiece';
import { feedLimitLine, saveLimitLine } from '$lib/utils/limitCopy';
import { readerUrl } from '$lib/utils/readerLink';
import { blockedSaveAction, extensionCanHelp, failedSaveLine } from '$lib/utils/saveAnywhere';
import { collectionOf, isRecordUri, repoOf, type WorkspaceItem } from './protocol';

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
 * fetched, since documents are public. The navigation resets the history
 * state, so a reader already open pops (useReaderStack's depth effect) and the
 * restore effect then opens this one as a cold load.
 *
 * Any app in the workspace can ask for this, unprompted. Over a list it costs
 * no more than the reader it replaces; anywhere else (settings, an editor) a
 * navigation could throw work away, so the reader is offered instead.
 */
export async function openDocument(uri: string, title?: string): Promise<void> {
  if (!isRecordUri(uri) || collectionOf(uri) !== DOCUMENT) return;
  const here = new URL(location.href);
  if (READER_SURFACES.includes(here.pathname)) {
    await goto(readerUrl(here, uri));
    return;
  }
  const href = readerUrl(new URL('/home', location.origin), uri);
  toastStore.update(
    toastStore.add(title ? `Open “${title}”?` : 'Open the document?'),
    'success',
    undefined,
    {
      label: 'Open',
      href,
    }
  );
}

// Saves and follows under way, by what they're keyed on: a double click in the
// other app sends `perform` twice, and the "already" checks can't see a save
// until it lands.
const pending = new Set<string>();

/** Run action `id` on `item`. The caller has checked the account. */
export async function perform(id: string, item: WorkspaceItem): Promise<void> {
  if (id === 'save') return save(item);
  if (id === 'follow') return follow(item);
}

async function save(item: WorkspaceItem): Promise<void> {
  const doc = isRecordUri(item.uri) && collectionOf(item.uri) === DOCUMENT ? item.uri : null;
  const key = doc ?? item.url;
  if (!key) return;
  if (pending.has(key)) return;
  const existing = (doc && savesStore.find(doc)) || (item.url && savesStore.find(item.url));
  if (existing) {
    toastStore.update(toastStore.add('Already saved'), 'success');
    return;
  }

  pending.add(key);
  const toast = toastStore.add('Saving…');
  try {
    if (doc) {
      const meta = await documentSave(doc, { url: item.url ?? '', title: item.title || undefined });
      // No record and no page means a save with nothing to read.
      if (meta.content === undefined && !meta.url) {
        toastStore.update(toast, 'error', 'Could not load that document');
        return;
      }
      await savesStore.saveDocument(meta);
    } else {
      const saved = await savesStore.saveFromUrl(item.url!, { title: item.title || undefined });
      // Only the link was kept: say so, and offer what a blocked save always does.
      if (saved.fetchFailed) {
        const action = extensionCanHelp(saved.fetchFailed) ? blockedSaveAction() : undefined;
        toastStore.update(toast, 'success', failedSaveLine(saved.fetchFailed), action);
        return;
      }
    }
    toastStore.update(toast, 'success', 'Saved to Skyreader');
  } catch (err) {
    if (err instanceof UrlSaveLimitError) {
      toastStore.update(toast, 'error', saveLimitLine(err.limit, err.resetsAt), {
        label: 'Become a Supporter',
        href: '/supporter',
      });
      return;
    }
    toastStore.update(toast, 'error', failure(err, 'Could not save that'));
  } finally {
    pending.delete(key);
  }
}

async function follow(item: WorkspaceItem): Promise<void> {
  const uri = item.uri;
  if (!isRecordUri(uri) || collectionOf(uri) !== PUBLICATION || pending.has(uri)) return;
  const did = repoOf(uri);
  if (subscriptionsStore.subscriptions.some((s) => s.feedUrl === uri)) {
    toastStore.update(toastStore.add('Already following'), 'success');
    return;
  }

  pending.add(uri);
  const title = item.title.trim() || 'Publication';
  const toast = toastStore.add('Following…');
  try {
    await subscriptionsStore.add(uri, title, {
      sourceType: 'atproto.documents',
      subjectDid: did,
      siteUrl: item.url,
      feedUrl: uri,
    });
    // Its documents now, so the feed isn't empty until the next refresh.
    void fetchAllDocuments(subscriptionsStore.subscriptions);
    toastStore.update(toast, 'success', `Following ${title}`);
  } catch (err) {
    toastStore.update(
      toast,
      'error',
      err instanceof SubscriptionLimitError
        ? feedLimitLine(err.limit)
        : failure(err, 'Could not follow that')
    );
  } finally {
    pending.delete(uri);
  }
}

function failure(err: unknown, fallback: string): string {
  // A permission upgrade runs on the auth server, which won't load in a frame.
  if (err instanceof ScopeUpgradeError) return 'Open Skyreader in its own tab to allow that first';
  return err instanceof Error && err.message ? err.message : fallback;
}
