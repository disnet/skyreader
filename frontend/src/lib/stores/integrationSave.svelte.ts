// Saving an article out to Semble or Margin, as one global session.
//
// The collection picker used to be local state in FeedPage, so only the
// surfaces that page renders (the river and the saved list) could offer
// "Save to Semble / Margin" — every other reader host (Home, Highlights, the
// daily magazine, the linkblog) rendered the discussion with those handlers
// missing, and the panel's "Add yours" row silently dropped the two lanes it
// couldn't act on. The flow lives here instead, and the picker is mounted once
// in AppShell, so any surface can open it without threading props.
//
// Saving is additive: a card/bookmark is created in the chosen collections. An
// article already in a collection can be saved again into another one, which is
// how you edit where it lives.
import { api, ScopeUpgradeError } from '$lib/services/api';
import { syncQueue, type IntegrationPayload } from '$lib/services/sync-queue';
import { syncStore } from '$lib/stores/sync.svelte';
import { toastStore } from '$lib/stores/toast.svelte';
import type { IntegrationKind } from '$lib/stores/collections.svelte';

export interface IntegrationSaveTarget {
  url: string;
  title?: string;
  description?: string;
  author?: string;
  publishedAt?: string;
}

export interface CollectionChoice {
  uri: string;
  cid: string;
}

function createIntegrationSaveStore() {
  let open = $state(false);
  let integration = $state<IntegrationKind>('semble');
  let target = $state<IntegrationSaveTarget | null>(null);

  function openPicker(kind: IntegrationKind, data: IntegrationSaveTarget) {
    integration = kind;
    target = data;
    open = true;
  }

  function close() {
    open = false;
    target = null;
  }

  async function select(collections: CollectionChoice[]) {
    open = false;
    const data = target;
    if (!data) return;
    target = null;

    const isMargin = integration === 'margin';
    const label = isMargin ? 'Margin' : 'Semble';

    const payload: IntegrationPayload = {
      type: integration,
      url: data.url,
      title: data.title,
      description: data.description,
      author: data.author,
      publishedAt: data.publishedAt,
      collections,
    };

    const savedSuffix =
      collections.length > 0
        ? ` (${collections.length} collection${collections.length === 1 ? '' : 's'})`
        : '';

    if (!syncStore.isOnline) {
      await syncQueue.enqueue('create', 'integration', data.url, payload);
      const id = toastStore.add(`Queued save to ${label}`);
      toastStore.update(id, 'success');
      return;
    }

    const id = toastStore.add(`Saving to ${label}...`);
    try {
      if (isMargin) {
        await api.createMarginBookmark({
          url: data.url,
          title: data.title,
          description: data.description,
          collectionUris: collections.map((c) => c.uri),
        });
      } else {
        await api.createSembleCard({
          url: data.url,
          title: data.title,
          description: data.description,
          author: data.author,
          publishedAt: data.publishedAt,
          collections,
        });
      }
      toastStore.update(id, 'success', `Saved to ${label}${savedSuffix}`);
    } catch (err) {
      if (err instanceof ScopeUpgradeError) {
        toastStore.update(id, 'error', 'Please log in again to grant integration permissions');
        return;
      }
      console.error(`Failed to save to ${label}, queueing:`, err);
      await syncQueue.enqueue('create', 'integration', data.url, payload);
      toastStore.update(id, 'success', `Queued save to ${label}`);
    }
  }

  return {
    get open() {
      return open;
    },
    get integration() {
      return integration;
    },
    /** Open the collection picker for `kind`, then save `data` into the choice. */
    openPicker,
    close,
    select,
  };
}

export const integrationSaveStore = createIntegrationSaveStore();
