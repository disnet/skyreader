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
// A first save is additive: a card/bookmark is created in the chosen collections.
// Re-opening the picker on an article that's already there is an EDIT — the picker
// reads the live membership and hands back a diff, which we apply as added links
// and deleted links. Editing is online-only (a diff against stale state would
// delete the wrong links), so there's no queueing on that path; the create path
// keeps its offline queue untouched.
import { api, ScopeUpgradeError } from '$lib/services/api';
import { syncQueue, type IntegrationPayload } from '$lib/services/sync-queue';
import { syncStore } from '$lib/stores/sync.svelte';
import { toastStore } from '$lib/stores/toast.svelte';
import { auth } from '$lib/stores/auth.svelte';
import { collectionsStore, type IntegrationKind } from '$lib/stores/collections.svelte';
import type { CollectionPickerResult, CollectionSelection } from '$lib/types';

export interface IntegrationSaveTarget {
  url: string;
  title?: string;
  description?: string;
  author?: string;
  publishedAt?: string;
}

export type CollectionChoice = CollectionSelection;

function createIntegrationSaveStore() {
  let open = $state(false);
  let integration = $state<IntegrationKind>('semble');
  let target = $state<IntegrationSaveTarget | null>(null);

  function openPicker(kind: IntegrationKind, data: IntegrationSaveTarget) {
    // Both integrations write to the reader's own atproto repo, and the picker
    // lists collections read from it — for a guest it would open empty and the
    // save behind it could only queue an entry that never drains (no session,
    // no granted scope). Every calling surface hides the action; this is the
    // backstop, and it says what to do instead.
    if (auth.isGuest) {
      const id = toastStore.add(`Sign in to save to ${kind === 'margin' ? 'Margin' : 'Semble'}`);
      toastStore.update(id, 'error', undefined, {
        label: 'Sign in',
        href: '/auth/login?returnUrl=/saved',
      });
      return;
    }
    integration = kind;
    target = data;
    open = true;
  }

  function close() {
    open = false;
    target = null;
  }

  /** Apply whatever the picker decided: a first save, or a membership edit. */
  async function confirm(result: CollectionPickerResult) {
    const chosen = result.mode === 'edit' ? result.add : result.collections;
    // Stamp recency from the choice, before the write — the picker leads with
    // recently-used collections, and that ordering should reflect what the
    // reader just decided even if the request is queued or fails.
    void collectionsStore.markUsed(
      integration,
      chosen.map((c) => c.uri)
    );

    if (result.mode === 'edit') {
      await applyEdit(result.add, result.remove);
      return;
    }
    await save(result.collections);
  }

  async function save(collections: CollectionChoice[]) {
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

  /**
   * Change which collections an existing save belongs to. Online-only on purpose:
   * the removals name specific membership records read moments ago, so there's
   * nothing safe to queue — a failure keeps the toast and invites a retry.
   */
  async function applyEdit(add: CollectionChoice[], remove: string[]) {
    open = false;
    const data = target;
    if (!data) return;
    target = null;

    const label = integration === 'margin' ? 'Margin' : 'Semble';
    const id = toastStore.add(`Updating ${label} save...`);
    try {
      const res = await api.editIntegrationMemberships(integration, {
        url: data.url,
        add,
        remove,
        title: data.title,
        description: data.description,
        author: data.author,
        publishedAt: data.publishedAt,
      });
      const failed = [...res.added, ...res.removed].filter((r) => r.error).length;
      if (failed > 0) {
        toastStore.update(
          id,
          'error',
          `${label} save partly updated — ${failed} change${failed === 1 ? '' : 's'} failed`
        );
        return;
      }
      toastStore.update(id, 'success', `${label} save updated`);
    } catch (err) {
      if (err instanceof ScopeUpgradeError) {
        toastStore.update(id, 'error', 'Please log in again to grant integration permissions');
        return;
      }
      console.error(`Failed to update ${label} save:`, err);
      toastStore.update(id, 'error', `Couldn't update ${label} save`);
    }
  }

  return {
    get open() {
      return open;
    },
    get integration() {
      return integration;
    },
    /** The URL the picker is open for — it looks up that URL's existing saves. */
    get url() {
      return target?.url;
    },
    /** Open the collection picker for `kind`, then save `data` into the choice. */
    openPicker,
    close,
    confirm,
  };
}

export const integrationSaveStore = createIntegrationSaveStore();
