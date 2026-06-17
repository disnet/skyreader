<script lang="ts">
  import { onMount } from 'svelte';
  import { browser } from '$app/environment';
  import { goto } from '$app/navigation';
  import { auth } from '$lib/stores/auth.svelte';
  import { subscriptionsStore } from '$lib/stores/subscriptions.svelte';
  import { savesStore } from '$lib/stores/saves.svelte';
  import {
    preferences,
    type ArticleFont,
    type ArticleFontSize,
  } from '$lib/stores/preferences.svelte';
  import ImportOPMLModal from '$lib/components/ImportOPMLModal.svelte';
  import Icon from '$lib/components/Icon.svelte';
  import StaticPageChrome from '$lib/components/feed/StaticPageChrome.svelte';
  import { downloadOPML } from '$lib/utils/opml-exporter';
  import { api, RateLimitError, ScopeUpgradeError } from '$lib/services/api';
  import { syncStore } from '$lib/stores/sync.svelte';
  import { collectionsStore } from '$lib/stores/collections.svelte';
  import { viewTitleStore } from '$lib/stores/viewTitle.svelte';
  import type { LinkblogPublication, SaveBacking } from '$lib/types';

  $effect(() => {
    viewTitleStore.set('Settings');
    return () => viewTitleStore.set('');
  });

  const fontOptions: { value: ArticleFont; label: string; family: string }[] = [
    { value: 'sans-serif', label: 'Sans Serif', family: 'sans-serif' },
    { value: 'serif', label: 'Serif', family: 'serif' },
    { value: 'mono', label: 'Monospace', family: 'monospace' },
    { value: 'literata', label: 'Literata', family: 'Literata, serif' },
  ];

  const fontSizeOptions: { value: ArticleFontSize; label: string }[] = [
    { value: 'xs', label: 'XS' },
    { value: 'sm', label: 'S' },
    { value: 'md', label: 'M' },
    { value: 'lg', label: 'L' },
    { value: 'xl', label: 'XL' },
  ];

  let showImportModal = $state(false);

  // "Save from anywhere" — browser bookmarklets + a Share Sheet shortcut.
  // Paste a published iCloud Shortcut link (icloud.com/shortcuts/...) into either
  // constant to turn the manual steps into a one-tap "Add Shortcut" button.
  const APPLE_SAVE_SHORTCUT_URL =
    'https://www.icloud.com/shortcuts/ead7df12455949fa92271ec3d0bea3f7';
  const APPLE_SUBSCRIBE_SHORTCUT_URL =
    'https://www.icloud.com/shortcuts/4b70e834a8ae48ee8c039cbf01e5b8c4';

  // Build links against the current origin so they also work on staging/local.
  const appOrigin = browser ? window.location.origin : 'https://skyreader.app';
  const saveBookmarklet = `javascript:void(window.open('${appOrigin}/save?url='+encodeURIComponent(location.href)))`;
  const subscribeBookmarklet = `javascript:void(window.open('${appOrigin}/subscribe?url='+encodeURIComponent(location.href)))`;

  let copiedKey = $state<string | null>(null);
  let bookmarkletHint = $state(false);

  async function copyText(text: string, key: string) {
    try {
      await navigator.clipboard.writeText(text);
      copiedKey = key;
      setTimeout(() => {
        if (copiedKey === key) copiedKey = null;
      }, 1500);
    } catch {
      // Clipboard unavailable (e.g. insecure context); the drag target still works.
    }
  }

  // A bookmarklet is meant to be dragged to the bookmarks bar, not clicked here:
  // the app's CSP blocks the javascript: navigation anyway. Nudge the user.
  function showDragHint(e: MouseEvent) {
    e.preventDefault();
    bookmarkletHint = true;
  }

  // PDS Sync state
  let pdsSyncEnabled = $state(false);
  let lastSyncSubscriptions = $state<number | null>(null);
  let isSyncLoading = $state(false);
  let isSyncing = $state(false);
  let syncError = $state<string | null>(null);
  let syncSuccess = $state<string | null>(null);

  // External-backed saves ("backup engine for your saves")
  let backing = $state<SaveBacking>({ provider: 'skyreader' });
  let scopeStatus = $state<{ semble: boolean; margin: boolean }>({ semble: false, margin: false });
  let configuring = $state<'semble' | 'margin' | null>(null); // provider being set up
  let chosenCollectionUri = $state(''); // '' = create a new default "Skyreader Saves"
  let exportExisting = $state(true);
  let backingBusy = $state(false);
  let backingError = $state<string | null>(null);
  let backingSuccess = $state<string | null>(null);
  // Live progress while copying existing saves into the collection (null when not running).
  let backingExportProgress = $state<{ current: number; total: number } | null>(null);

  const providerLabel = (p: 'semble' | 'margin') => (p === 'semble' ? 'Semble' : 'Margin');

  // Collection picker: users may have a lot of collections, so filter by name and
  // cap how many radios we render at once (search to reach the rest).
  const COLLECTION_DISPLAY_LIMIT = 8;
  let collectionSearch = $state('');
  const allCollections = $derived(configuring ? collectionsStore.collections[configuring] : []);
  const filteredCollections = $derived.by(() => {
    const q = collectionSearch.trim().toLowerCase();
    if (!q) return allCollections;
    return allCollections.filter((c) => (c.name || '').toLowerCase().includes(q));
  });
  const visibleCollections = $derived.by(() => {
    const list = filteredCollections;
    if (list.length <= COLLECTION_DISPLAY_LIMIT) return list;
    const head = list.slice(0, COLLECTION_DISPLAY_LIMIT);
    // Keep the currently-chosen collection visible even if it'd fall past the cap.
    const chosen = chosenCollectionUri && list.find((c) => c.uri === chosenCollectionUri);
    if (chosen && !head.some((c) => c.uri === chosen.uri)) {
      return [chosen, ...head.slice(0, COLLECTION_DISPLAY_LIMIT - 1)];
    }
    return head;
  });
  const hiddenCount = $derived(filteredCollections.length - visibleCollections.length);

  // Linkblog publication settings
  let linkblogPub = $state<LinkblogPublication | null>(null);
  let linkblogName = $state('');
  let linkblogDescription = $state('');
  let isLinkblogLoading = $state(false);
  let isSavingLinkblog = $state(false);
  let linkblogError = $state<string | null>(null);
  let linkblogSuccess = $state<string | null>(null);

  onMount(async () => {
    if (!auth.isAuthenticated) {
      goto('/auth/login?returnUrl=/settings');
      return;
    }
    // Load subscriptions if not already loaded
    if (subscriptionsStore.subscriptions.length === 0) {
      await subscriptionsStore.load();
    }

    // Load PDS sync settings
    await loadSyncSettings();
    await loadLinkblog();
  });

  async function loadLinkblog() {
    if (!syncStore.isOnline) return;
    isLinkblogLoading = true;
    try {
      const pub = await api.getLinkblogPublication();
      linkblogPub = pub;
      linkblogName = pub.name;
      linkblogDescription = pub.description ?? '';
    } catch (error) {
      console.error('Failed to load linkblog publication:', error);
    } finally {
      isLinkblogLoading = false;
    }
  }

  async function handleSaveLinkblog() {
    if (isSavingLinkblog) return;
    if (!syncStore.isOnline) {
      linkblogError = 'You are offline. Connect to the internet to update your linkblog.';
      return;
    }
    isSavingLinkblog = true;
    linkblogError = null;
    linkblogSuccess = null;
    try {
      const pub = await api.updateLinkblogPublication({
        name: linkblogName,
        description: linkblogDescription,
      });
      linkblogPub = pub;
      linkblogName = pub.name;
      linkblogDescription = pub.description ?? '';
      linkblogSuccess = 'Saved.';
    } catch (error) {
      console.error('Failed to update linkblog publication:', error);
      linkblogError = error instanceof Error ? error.message : 'Failed to save.';
    } finally {
      isSavingLinkblog = false;
    }
  }

  async function loadSyncSettings() {
    if (!syncStore.isOnline) return;
    isSyncLoading = true;
    try {
      const settings = await api.getSettings();
      pdsSyncEnabled = settings.pdsSyncEnabled;
      lastSyncSubscriptions = settings.lastPdsSyncSubscriptions;
      backing = settings.backing;
      // Scope status gates the engine picker (writing to Semble/Margin needs grants).
      try {
        const status = await api.getIntegrationStatus();
        scopeStatus = status.scopeStatus;
      } catch (err) {
        console.error('Failed to load integration status:', err);
      }
    } catch (error) {
      console.error('Failed to load sync settings:', error);
    } finally {
      isSyncLoading = false;
    }
  }

  function startConfigure(provider: 'semble' | 'margin') {
    backingError = null;
    backingSuccess = null;
    configuring = provider;
    chosenCollectionUri = '';
    collectionSearch = '';
    exportExisting = true;
    collectionsStore.loadAndRefresh(provider);
  }

  function cancelConfigure() {
    configuring = null;
    backingError = null;
  }

  async function reauthForScopes() {
    await auth.logout();
    goto('/auth/login?returnUrl=/settings');
  }

  async function handleEnableBacking() {
    if (!configuring || backingBusy) return;
    if (!syncStore.isOnline) {
      backingError = 'You are offline. Connect to the internet to change this.';
      return;
    }
    const provider = configuring;
    const copyExisting = exportExisting;
    backingBusy = true;
    backingError = null;
    backingSuccess = null;
    backingExportProgress = null;
    try {
      const res = await api.setBacking({
        action: 'enable',
        provider,
        collectionUri: chosenCollectionUri || undefined,
      });
      backing = res.backing;

      // Copy existing saves in batches so the user sees progress instead of a long
      // silent wait. The cursor advances by `scanned` (not `exported`), so skipped or
      // already-backed saves still move it forward — the loop always terminates.
      let exported = 0;
      if (copyExisting) {
        backingExportProgress = { current: 0, total: 0 };
        let offset = 0;
        const maxBatches = 4000; // safety backstop (≥ any real library at 25/batch)
        for (let i = 0; i < maxBatches; i++) {
          let batch;
          try {
            batch = await api.exportSavesBatch(offset);
          } catch (err) {
            if (err instanceof RateLimitError) {
              await sleep(Math.min(err.retryAfter, 300) * 1000);
              continue; // retry the same offset after the cooldown
            }
            throw err;
          }
          exported += batch.exported;
          offset += batch.scanned;
          backingExportProgress = { current: Math.min(offset, batch.total), total: batch.total };
          if (batch.scanned === 0 || offset >= batch.total) break;
        }
      }

      configuring = null;
      backingExportProgress = null;
      backingSuccess = exported
        ? `Your saves are backed by ${providerLabel(provider)}. ${exported} existing ${exported === 1 ? 'save' : 'saves'} copied in.`
        : `Your saves are backed by ${providerLabel(provider)}.`;
      // Refresh the Saved list so it reflects the collection.
      try {
        await savesStore.load();
      } catch {
        // best-effort; the saved view reloads on next open
      }
    } catch (err) {
      backingExportProgress = null;
      if (err instanceof ScopeUpgradeError) {
        backingError = `Log in again to grant ${providerLabel(provider)} permissions, then turn this on.`;
      } else {
        backingError = err instanceof Error ? err.message : 'Failed to turn on backing.';
      }
    } finally {
      backingBusy = false;
    }
  }

  async function handleDisableBacking() {
    if (backingBusy) return;
    if (!syncStore.isOnline) {
      backingError = 'You are offline. Connect to the internet to change this.';
      return;
    }
    backingBusy = true;
    backingError = null;
    backingSuccess = null;
    try {
      const res = await api.setBacking({ action: 'disable' });
      backing = res.backing;
      backingSuccess = 'Backing is off. Your saves are on Skyreader again.';
      try {
        await savesStore.load();
      } catch {
        // best-effort
      }
    } catch (err) {
      backingError = err instanceof Error ? err.message : 'Failed to turn off backing.';
    } finally {
      backingBusy = false;
    }
  }

  async function handleTogglePdsSync(event: Event) {
    const target = event.currentTarget as HTMLInputElement;
    const newValue = target.checked;

    syncError = null;
    syncSuccess = null;

    if (!syncStore.isOnline) {
      syncError = 'You are offline. Connect to the internet to change sync settings.';
      pdsSyncEnabled = !newValue;
      return;
    }

    try {
      const settings = await api.updateSettings({ pdsSyncEnabled: newValue });
      pdsSyncEnabled = settings.pdsSyncEnabled;

      // If enabling sync, trigger an initial sync
      if (newValue) {
        await handleSync();
      }
    } catch (error) {
      console.error('Failed to update sync setting:', error);
      syncError = error instanceof Error ? error.message : 'Failed to update setting';
      // Revert the checkbox
      pdsSyncEnabled = !newValue;
    }
  }

  function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async function handleSync() {
    if (isSyncing) return;

    if (!syncStore.isOnline) {
      syncError = 'You are offline. Connect to the internet to sync.';
      return;
    }

    isSyncing = true;
    syncError = null;
    syncSuccess = null;

    // Track totals across multiple sync calls (for batched hasMore syncs)
    let totalPulled = 0;
    let totalPushed = 0;
    let totalImported = 0;
    let totalRemoved = 0;
    let allWarnings: string[] = [];
    let batchCount = 0;
    const maxBatches = 50; // Safety limit to prevent infinite loops

    try {
      let hasMore = true;

      while (hasMore && batchCount < maxBatches) {
        batchCount++;
        if (batchCount > 1) {
          syncSuccess = `Syncing batch ${batchCount}...`;
        }

        let result;
        try {
          result = await api.triggerFullSync();
        } catch (error) {
          // Handle rate limit by waiting and retrying
          if (error instanceof RateLimitError) {
            const waitSeconds = Math.min(error.retryAfter, 300); // Cap at 5 minutes
            syncSuccess = `Rate limit reached. Waiting ${waitSeconds}s before continuing...`;
            await sleep(waitSeconds * 1000);
            // Retry this batch
            batchCount--;
            continue;
          }
          throw error;
        }

        if (result.needsReauth) {
          syncError = 'Your data moved to a new PDS. Sign in again to reconnect Atmospheric sync.';
          return;
        }

        if (!result.success) {
          syncError = result.error || 'Sync failed';
          return;
        }

        // Accumulate totals
        totalPulled += result.subscriptions?.pulledFromPds || 0;
        totalPushed += result.subscriptions?.pushedToPds || 0;
        totalImported += result.atmosphere?.imported || 0;
        totalRemoved += result.atmosphere?.removed || 0;

        // Collect warnings
        allWarnings = [
          ...allWarnings,
          ...(result.subscriptions?.warnings || []),
          ...(result.atmosphere?.warnings || []),
        ];

        // Check if there's more to sync
        hasMore = result.hasMore || false;
      }

      syncSuccess = `Sync complete: ${totalPulled} pulled, ${totalPushed} pushed`;
      if (totalImported > 0 || totalRemoved > 0) {
        syncSuccess += `. Atmosphere: ${totalImported} imported, ${totalRemoved} removed`;
      }
      if (batchCount > 1) {
        syncSuccess += ` (${batchCount} batches)`;
      }

      // Show warnings if any
      if (allWarnings.length > 0) {
        syncSuccess += `. Warning: ${allWarnings.join(', ')}`;
      }

      // Refresh sync status
      const status = await api.getSyncStatus();
      lastSyncSubscriptions = status.lastSyncSubscriptions;

      // Reload subscriptions to show any pulled items
      await subscriptionsStore.load();
    } catch (error) {
      console.error('Sync error:', error);
      syncError = error instanceof Error ? error.message : 'Sync failed';
    } finally {
      isSyncing = false;
    }
  }

  function formatSyncTime(timestamp: number | null): string {
    if (!timestamp) return 'Never';
    const date = new Date(timestamp * 1000);
    return date.toLocaleString();
  }

  async function handleLogout() {
    if (confirm('Are you sure you want to log out?')) {
      await auth.logout();
      goto('/');
    }
  }

  let isUnsubscribingAll = $state(false);

  async function handleUnsubscribeAll() {
    const count = subscriptionsStore.subscriptions.length;
    if (count === 0) return;

    if (
      !confirm(
        `Are you sure you want to unsubscribe from all ${count} feeds? This cannot be undone.`
      )
    ) {
      return;
    }

    isUnsubscribingAll = true;
    try {
      await subscriptionsStore.removeAll();
    } finally {
      isUnsubscribingAll = false;
    }
  }
</script>

<StaticPageChrome title="Settings" />

<div class="settings-page">
  {#if auth.user}
    <section class="card">
      <h2>Account</h2>
      <div class="user-info">
        {#if auth.user.avatarUrl}
          <img src={auth.user.avatarUrl} alt="" class="avatar" />
        {/if}
        <div>
          <p class="display-name">
            {auth.user.displayName || auth.user.handle}
          </p>
          <p class="handle">@{auth.user.handle}</p>
          <p class="did">{auth.user.did}</p>
        </div>
      </div>
      <button class="btn btn-danger" onclick={handleLogout}> Log Out </button>
    </section>

    <section class="card">
      <h2>Plan</h2>
      <div class="plan-header">
        <span class="plan-name">{auth.user.tier === 'supporter' ? 'Supporter' : 'Free'}</span>
      </div>

      {#if auth.user.limits}
        {@const subCount = subscriptionsStore.subscriptions.length}
        {@const subLimit = auth.user.limits.maxSubscriptions}
        {@const urlSaveLimit = auth.user.limits.maxUrlSavesPerMonth}
        {@const monthStart = new Date(
          Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1)
        ).toISOString()}
        {@const urlSaveCount = savesStore.articles.filter(
          (a) => a.source === 'url' && a.savedAt >= monthStart
        ).length}
        <div class="plan-limits">
          <div class="limit-row">
            <div class="limit-label">
              <span>Feed subscriptions</span>
              <span class="limit-numbers">{subCount} / {subLimit}</span>
            </div>
            <div class="limit-bar">
              <div
                class="limit-bar-fill"
                class:limit-bar-warning={subCount / subLimit > 0.8}
                class:limit-bar-full={subCount >= subLimit}
                style:width="{Math.min((subCount / subLimit) * 100, 100)}%"
              ></div>
            </div>
          </div>

          <div class="limit-row">
            <div class="limit-label">
              <span>URL saves this month</span>
              <span class="limit-numbers">{urlSaveCount} / {urlSaveLimit}</span>
            </div>
            <div class="limit-bar">
              <div
                class="limit-bar-fill"
                class:limit-bar-warning={urlSaveCount / urlSaveLimit > 0.8}
                class:limit-bar-full={urlSaveCount >= urlSaveLimit}
                style:width="{Math.min((urlSaveCount / urlSaveLimit) * 100, 100)}%"
              ></div>
            </div>
          </div>
        </div>
      {/if}

      {#if auth.user.tier !== 'supporter'}
        <p class="plan-upgrade">
          <a href="https://github.com/sponsors/disnet" target="_blank" rel="noopener noreferrer"
            >Become a sponsor</a
          >
          to get raised limits, help Skyreader become self-sustaining, and support
          <a href="https://bsky.app/profile/disnetdev.com" target="_blank">Tim</a>!
        </p>
      {/if}
    </section>
  {/if}

  <section class="card">
    <h2>The Atmosphere</h2>
    <p class="setting-description" style="margin-top: 0;">
      Your <strong>shares and saves always live in the Atmosphere</strong> — stored on your atproto
      PDS, where they're portable to any Atmospheric app and publicly visible.
      {#if auth.user}
        <a
          href="https://pdsls.dev/at://{auth.user.did}"
          target="_blank"
          rel="noopener noreferrer"
          class="pds-link">View your PDS data</a
        >
      {/if}
    </p>

    {#if isSyncLoading}
      <p class="loading">Loading sync settings...</p>
    {:else}
      <div class="sync-toggle-section">
        <label class="toggle-setting">
          <input type="checkbox" checked={pdsSyncEnabled} onchange={handleTogglePdsSync} />
          <span>Turn on Atmospheric sync</span>
        </label>
        <p class="setting-description">
          Also store your feed subscriptions on your PDS. They'll be backed up and portable across
          the Atmosphere, but become <strong>publicly visible</strong>. Your standard.site
          subscriptions stay in step too — follow or unfollow in either place and the other follows
          along.
        </p>
      </div>

      {#if pdsSyncEnabled}
        <div class="sync-status">
          <p class="sync-time">
            Subscriptions last synced: {formatSyncTime(lastSyncSubscriptions)}
          </p>
        </div>

        <button class="btn btn-secondary" onclick={handleSync} disabled={isSyncing}>
          {#if isSyncing}
            Syncing...
          {:else}
            Sync Now
          {/if}
        </button>

        {#if syncError}
          <p class="sync-error">{syncError}</p>
        {/if}

        {#if syncSuccess}
          <p class="sync-success">{syncSuccess}</p>
        {/if}
      {/if}
    {/if}
  </section>

  <section class="card">
    <h2>Where your saves live</h2>
    <p class="setting-description" style="margin-top: 0;">
      Pick the <strong>backup engine</strong> for your saved articles. All three keep your saves on your
      PDS, portable across the Atmosphere. They differ in which schema they speak, and so which apps can
      edit your list. You can change this anytime.
    </p>

    {#if isSyncLoading}
      <p class="loading">Loading…</p>
    {:else}
      <div class="engine-options">
        <!-- Skyreader -->
        <button
          class="engine-option"
          class:selected={backing.provider === 'skyreader'}
          onclick={() => backing.provider !== 'skyreader' && handleDisableBacking()}
          disabled={backingBusy}
          type="button"
        >
          <span class="engine-check" aria-hidden="true">
            {#if backing.provider === 'skyreader'}<Icon name="check" size={14} />{/if}
          </span>
          <span class="engine-info">
            <span class="engine-name">Skyreader</span>
            <span class="engine-desc">
              Saves stay on Skyreader. With Atmospheric sync on, they also back up to your PDS.
            </span>
          </span>
        </button>

        <!-- Semble / Margin -->
        {#each ['semble', 'margin'] as const as provider}
          <button
            class="engine-option"
            class:selected={backing.provider === provider}
            onclick={() => backing.provider !== provider && startConfigure(provider)}
            disabled={backingBusy}
            type="button"
          >
            <span class="engine-check" aria-hidden="true">
              {#if backing.provider === provider}<Icon name="check" size={14} />{/if}
            </span>
            <span class="engine-info">
              <span class="engine-name">{providerLabel(provider)}</span>
              <span class="engine-desc">
                Your Saved list becomes a {providerLabel(provider)} collection. Edit it in
                {providerLabel(provider)} or any Atmospheric app.
              </span>
            </span>
          </button>
        {/each}
      </div>

      <!-- Current backing summary -->
      {#if backing.provider !== 'skyreader' && configuring === null}
        <div class="backing-status">
          <p class="sync-time">
            Backed by {providerLabel(backing.provider)}.
            <a
              href="https://pdsls.dev/{backing.collectionUri}"
              target="_blank"
              rel="noopener noreferrer">View the collection</a
            >
          </p>
          <button class="btn btn-danger" onclick={handleDisableBacking} disabled={backingBusy}>
            {#if backingBusy}Working…{:else}Turn off backing{/if}
          </button>
        </div>
      {/if}

      <!-- Configure panel for a provider being enabled -->
      {#if configuring !== null}
        <div class="backing-config">
          {#if !scopeStatus[configuring]}
            <p class="setting-description" style="margin-top: 0;">
              Backing with {providerLabel(configuring)} needs permission to write to your
              {providerLabel(configuring)} collections.
            </p>
            <div class="backing-actions">
              <button class="btn btn-primary" onclick={reauthForScopes} type="button">
                Log in again to grant access
              </button>
              <button class="btn btn-secondary" onclick={cancelConfigure} type="button">
                Cancel
              </button>
            </div>
          {:else}
            <p class="config-label">Choose a collection</p>
            <div class="collection-picker" role="radiogroup" aria-label="Choose a collection">
              <!-- Default: create a fresh collection. Always available, even while
                   existing collections are still loading. -->
              <label class="collection-option is-new" class:selected={chosenCollectionUri === ''}>
                <input type="radio" value="" bind:group={chosenCollectionUri} />
                <span class="collection-radio" aria-hidden="true"></span>
                <span class="collection-glyph" aria-hidden="true">
                  <Icon name="folder-plus" size={18} />
                </span>
                <span class="collection-info">
                  <span class="collection-name">Create a new collection</span>
                  <span class="collection-meta">A fresh “Skyreader Saves” collection</span>
                </span>
              </label>

              {#if collectionsStore.loading[configuring] && allCollections.length === 0}
                <p class="loading">Loading your collections…</p>
              {:else if allCollections.length > 0}
                <div class="collection-sep" role="presentation"></div>

                {#if allCollections.length > COLLECTION_DISPLAY_LIMIT}
                  <div class="collection-search-wrap">
                    <span class="collection-search-icon" aria-hidden="true">
                      <Icon name="search" size={15} />
                    </span>
                    <input
                      class="collection-search"
                      type="search"
                      placeholder="Search your collections…"
                      bind:value={collectionSearch}
                      aria-label="Search your collections"
                    />
                  </div>
                {/if}

                {#if filteredCollections.length === 0 && collectionSearch.trim()}
                  <p class="collection-empty">
                    No collections match “{collectionSearch.trim()}”.
                  </p>
                {:else}
                  <div class="collection-list">
                    {#each visibleCollections as col (col.uri)}
                      <label
                        class="collection-option"
                        class:selected={chosenCollectionUri === col.uri}
                      >
                        <input type="radio" value={col.uri} bind:group={chosenCollectionUri} />
                        <span class="collection-radio" aria-hidden="true"></span>
                        <span class="collection-info">
                          <span class="collection-name">{col.name || 'Untitled'}</span>
                          {#if col.description}
                            <span class="collection-meta">{col.description}</span>
                          {/if}
                        </span>
                      </label>
                    {/each}
                  </div>
                {/if}

                {#if hiddenCount > 0}
                  <p class="collection-more">
                    Showing {visibleCollections.length} of {filteredCollections.length}. Search to
                    find the rest.
                  </p>
                {/if}
              {/if}
            </div>

            <div class="backing-warning">
              <strong>Backing publishes all of your saves publicly.</strong>
              Your {providerLabel(configuring)} collection is public, and there is no per-save exception.
              If you keep saves you would rather not share, leave this off.
            </div>

            <label class="toggle-setting export-toggle">
              <input type="checkbox" bind:checked={exportExisting} />
              <span>Also copy my existing saves into this collection</span>
            </label>

            {#if backingExportProgress}
              <div class="export-progress" aria-live="polite">
                <p class="config-label" style="margin-top: 0;">
                  Copying your saves into {providerLabel(configuring)}…
                </p>
                <div
                  class="progress-track"
                  role="progressbar"
                  aria-valuemin="0"
                  aria-valuemax={backingExportProgress.total}
                  aria-valuenow={backingExportProgress.current}
                >
                  <div
                    class="progress-bar-fill"
                    style="transform: scaleX({backingExportProgress.total > 0
                      ? backingExportProgress.current / backingExportProgress.total
                      : 0})"
                  ></div>
                </div>
                <p class="progress-count">
                  {backingExportProgress.current} / {backingExportProgress.total}
                </p>
              </div>
            {:else}
              <div class="backing-actions">
                <button
                  class="btn btn-primary"
                  onclick={handleEnableBacking}
                  disabled={backingBusy}
                >
                  {#if backingBusy}Turning on…{:else}Use {providerLabel(configuring)}{/if}
                </button>
                <button
                  class="btn btn-secondary"
                  onclick={cancelConfigure}
                  disabled={backingBusy}
                  type="button"
                >
                  Cancel
                </button>
              </div>
            {/if}
          {/if}
        </div>
      {/if}

      {#if backingError}
        <p class="sync-error">{backingError}</p>
      {/if}
      {#if backingSuccess}
        <p class="sync-success">{backingSuccess}</p>
      {/if}
    {/if}
  </section>

  <section class="card">
    <h2>Your linkblog</h2>
    <p class="setting-description" style="margin-top: 0;">
      Sharing an article publishes it to your <strong>linkblog</strong> — a portable publication in your
      PDS, public by design and readable across the Atmosphere.
    </p>
    {#if isLinkblogLoading}
      <p class="loading">Loading linkblog…</p>
    {:else}
      {#if linkblogPub}
        <p class="setting-description" style="margin-top: 0;">
          <a href={linkblogPub.url} target="_blank" rel="noopener noreferrer"
            >View your linkblog →</a
          >
        </p>
      {/if}
      <div class="linkblog-field">
        <label for="linkblog-name">Name</label>
        <input
          id="linkblog-name"
          type="text"
          bind:value={linkblogName}
          maxlength="120"
          placeholder="My links"
        />
      </div>
      <div class="linkblog-field">
        <label for="linkblog-description">Description</label>
        <textarea
          id="linkblog-description"
          bind:value={linkblogDescription}
          rows="2"
          maxlength="500"
          placeholder="Optional"
        ></textarea>
      </div>
      <button class="btn btn-secondary" onclick={handleSaveLinkblog} disabled={isSavingLinkblog}>
        {#if isSavingLinkblog}Saving…{:else}Save{/if}
      </button>
      {#if linkblogError}
        <p class="sync-error">{linkblogError}</p>
      {/if}
      {#if linkblogSuccess}
        <p class="sync-success">{linkblogSuccess}</p>
      {/if}
    {/if}
  </section>

  <section class="card">
    <h2>Appearance</h2>
    <div class="setting-row">
      <label for="article-font">Article Font</label>
      <div class="font-options">
        {#each fontOptions as option}
          <button
            class="font-option"
            class:selected={preferences.articleFont === option.value}
            onclick={() => preferences.setArticleFont(option.value)}
          >
            <span class="font-preview" style:font-family={option.family}>Aa</span>
            <span class="font-label">{option.label}</span>
          </button>
        {/each}
      </div>
    </div>
    <div class="setting-row">
      <label for="article-font-size">Article Font Size</label>
      <div class="font-options">
        {#each fontSizeOptions as option}
          <button
            class="font-size-option"
            class:selected={preferences.articleFontSize === option.value}
            onclick={() => preferences.setArticleFontSize(option.value)}
          >
            <span class="font-size-preview" data-size={option.value}>Aa</span>
            <span class="font-label">{option.label}</span>
          </button>
        {/each}
      </div>
    </div>
  </section>

  <section class="card">
    <h2>Reading</h2>
    <label class="toggle-setting">
      <input
        type="checkbox"
        checked={preferences.scrollToMarkAsRead}
        onchange={(e) => preferences.setScrollToMarkAsRead(e.currentTarget.checked)}
      />
      <span>Mark articles as read when scrolled past</span>
    </label>
    <p class="setting-description">
      Automatically mark articles as read when you scroll past them in the feed.
    </p>
  </section>

  <section class="card">
    <h2>Import / Export</h2>
    <p>Import or export your subscriptions using OPML or text files.</p>
    <div class="button-row">
      <button class="btn btn-secondary" onclick={() => (showImportModal = true)}>
        Import Feeds
      </button>
      <button
        class="btn btn-secondary"
        onclick={() => downloadOPML(subscriptionsStore.subscriptions)}
        disabled={subscriptionsStore.subscriptions.length === 0}
      >
        Export OPML
      </button>
    </div>
  </section>

  <section class="card" id="save-anywhere">
    <h2>Save from anywhere</h2>
    <p>Save an article or subscribe to a feed without leaving the page you're reading.</p>

    <h3 class="subhead">On your computer</h3>
    <p class="hint-text">Drag a button to your bookmarks bar, then click it on any page:</p>
    <div class="bookmarklet-row">
      <a class="bookmarklet" href={saveBookmarklet} onclick={showDragHint}>Save to Skyreader</a>
      <a class="bookmarklet" href={subscribeBookmarklet} onclick={showDragHint}>
        Subscribe in Skyreader
      </a>
    </div>
    {#if bookmarkletHint}
      <p class="hint-text">Drag these up to your bookmarks bar. Clicking here won't run them.</p>
    {/if}
    <div class="button-row">
      <button class="btn btn-secondary" onclick={() => copyText(saveBookmarklet, 'save')}>
        {copiedKey === 'save' ? 'Copied' : 'Copy Save link'}
      </button>
      <button class="btn btn-secondary" onclick={() => copyText(subscribeBookmarklet, 'subscribe')}>
        {copiedKey === 'subscribe' ? 'Copied' : 'Copy Subscribe link'}
      </button>
    </div>

    <h3 class="subhead">On iPhone or iPad</h3>
    {#if APPLE_SAVE_SHORTCUT_URL || APPLE_SUBSCRIBE_SHORTCUT_URL}
      <p class="hint-text">Add a shortcut, then use it from any Share Sheet:</p>
      <div class="button-row">
        {#if APPLE_SAVE_SHORTCUT_URL}
          <a
            class="btn btn-secondary"
            href={APPLE_SAVE_SHORTCUT_URL}
            target="_blank"
            rel="noopener noreferrer">Add Save shortcut</a
          >
        {/if}
        {#if APPLE_SUBSCRIBE_SHORTCUT_URL}
          <a
            class="btn btn-secondary"
            href={APPLE_SUBSCRIBE_SHORTCUT_URL}
            target="_blank"
            rel="noopener noreferrer">Add Subscribe shortcut</a
          >
        {/if}
      </div>
    {:else}
      <details class="shortcut-steps">
        <summary>Build a Share Sheet shortcut</summary>
        <ol>
          <li>Open the <strong>Shortcuts</strong> app and create a new shortcut.</li>
          <li>
            In its settings, turn on <strong>Show in Share Sheet</strong> and set the type to
            <strong>URLs</strong>.
          </li>
          <li>Add <strong>Get URLs from Input</strong>, set to Shortcut Input.</li>
          <li>Add <strong>URL Encode</strong> (Encode) on that URL.</li>
          <li>
            Add <strong>Text</strong>: <code>{appOrigin}/save?url=</code> followed by the Encoded
            URL. Use <code>/subscribe?url=</code> instead for a feed shortcut.
          </li>
          <li>Add <strong>Open URLs</strong> with that text.</li>
        </ol>
        <p class="hint-text">
          Share any page, pick your shortcut, and it opens here and saves while you stay logged in.
        </p>
      </details>
    {/if}

    <h3 class="subhead">On Android</h3>
    <p class="hint-text">
      Install Skyreader to your home screen and it appears right in the system share sheet. Share
      any page, pick Skyreader, and it saves the article. No setup needed.
    </p>
  </section>

  <section class="card">
    <h2>About</h2>
    <p>Skyreader is a reading app that helps you make sense of what you read.</p>
    <p>
      Your data is stored in your Personal Data Server (PDS), making it portable and under your
      control.
    </p>
    <div class="about-links">
      <a href="/terms">Terms of Service</a>
      <span class="separator">·</span>
      <a href="mailto:abuse@skyreader.app">Report Abuse</a>
      <span class="separator">·</span>
      <a
        href="https://userinput.app/#/s/did:plc:ra4jsemddo2ii4pn5jaf6x4v/3mobgsd6d5n27"
        target="_blank"
        rel="noopener noreferrer">Feedback</a
      >
    </div>
  </section>

  <section class="card debug-section">
    <h2>Debug</h2>
    <p>Development tools for testing.</p>
    <button
      class="btn btn-danger"
      onclick={handleUnsubscribeAll}
      disabled={isUnsubscribingAll || subscriptionsStore.subscriptions.length === 0}
    >
      {#if isUnsubscribingAll}
        Unsubscribing...
      {:else}
        Unsubscribe from All ({subscriptionsStore.subscriptions.length} feeds)
      {/if}
    </button>
  </section>
</div>

<ImportOPMLModal open={showImportModal} onclose={() => (showImportModal = false)} />

<style>
  .settings-page {
    max-width: 600px;
    margin: 0 auto;
    padding-top: 3.5rem;
  }

  @media (max-width: 1000px) {
    .settings-page {
      padding-top: 0.5rem;
      padding-bottom: calc(var(--bottom-bar-height) + var(--safe-area-bottom) + 1rem);
    }
  }

  section {
    margin-bottom: 1.5rem;
  }

  section h2 {
    font-size: var(--text-xl);
    margin-bottom: 1rem;
    padding-bottom: 0.5rem;
    border-bottom: 1px solid var(--color-border);
  }

  .user-info {
    display: flex;
    gap: 1rem;
    margin-bottom: 1rem;
  }

  .avatar {
    width: 64px;
    height: 64px;
    border-radius: 50%;
  }

  .display-name {
    font-weight: var(--weight-semibold);
  }

  .handle {
    color: var(--color-text-secondary);
  }

  .did {
    font-size: var(--text-xs);
    color: var(--color-text-secondary);
    word-break: break-all;
  }

  .plan-header {
    margin-bottom: 1rem;
  }

  .plan-name {
    display: inline-block;
    font-weight: var(--weight-semibold);
    font-size: var(--text-md);
    text-transform: uppercase;
    letter-spacing: var(--tracking-wider);
    padding: 0.25rem 0.625rem;
    border-radius: 4px;
    background: var(--color-bg-secondary);
    color: var(--color-text-secondary);
  }

  .plan-upgrade {
    margin-top: 1rem;
    font-size: var(--text-md);
    color: var(--color-text-secondary);
  }

  .plan-upgrade a {
    color: var(--color-primary);
    text-decoration: none;
  }

  .plan-upgrade a:hover {
    text-decoration: underline;
  }

  .plan-limits {
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }

  .limit-row {
    display: flex;
    flex-direction: column;
    gap: 0.375rem;
  }

  .limit-label {
    display: flex;
    justify-content: space-between;
    font-size: var(--text-md);
  }

  .limit-numbers {
    color: var(--color-text-secondary);
    font-variant-numeric: tabular-nums;
  }

  .limit-bar {
    height: 6px;
    background: var(--color-bg-secondary);
    border-radius: 3px;
    overflow: hidden;
  }

  .limit-bar-fill {
    height: 100%;
    background: var(--color-primary);
    border-radius: 3px;
    transition: width 0.3s ease;
  }

  .limit-bar-warning {
    background: var(--color-warning, #f59e0b);
  }

  .limit-bar-full {
    background: var(--color-danger);
  }

  .debug-section {
    border: 1px dashed var(--color-border);
    background: var(--color-bg-secondary);
  }

  .debug-section h2 {
    color: var(--color-text-secondary);
  }

  .setting-row {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .setting-row label {
    font-weight: var(--weight-medium);
    color: var(--color-text-secondary);
    font-size: var(--text-md);
  }

  .font-options {
    display: flex;
    gap: 0.75rem;
  }

  .font-option {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.25rem;
    padding: 0.75rem 1rem;
    background: var(--color-bg);
    border: 2px solid var(--color-border);
    border-radius: 8px;
    cursor: pointer;
    transition:
      border-color 0.15s,
      background-color 0.15s;
  }

  .font-option:hover {
    border-color: var(--color-primary);
  }

  .font-option.selected {
    border-color: var(--color-primary);
    background: var(--color-sidebar-active);
  }

  .font-preview {
    font-size: var(--text-3xl);
    line-height: var(--leading-none);
    /* Normalize visual size across families by x-height so the Literata
       preview matches the others — see AppearanceToolbar. */
    font-size-adjust: 0.52;
  }

  .font-label {
    font-size: var(--text-xs);
    color: var(--color-text-secondary);
  }

  .font-option.selected .font-label {
    color: var(--color-primary);
  }

  .font-size-option {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.25rem;
    padding: 0.75rem 1rem;
    background: var(--color-bg);
    border: 2px solid var(--color-border);
    border-radius: 8px;
    cursor: pointer;
    transition:
      border-color 0.15s,
      background-color 0.15s;
  }

  .font-size-option:hover {
    border-color: var(--color-primary);
  }

  .font-size-option.selected {
    border-color: var(--color-primary);
    background: var(--color-sidebar-active);
  }

  .font-size-option.selected .font-label {
    color: var(--color-primary);
  }

  .font-size-preview {
    line-height: var(--leading-none);
  }

  .font-size-preview[data-size='xs'] {
    font-size: var(--text-md);
  }

  .font-size-preview[data-size='sm'] {
    font-size: var(--text-base);
  }

  .font-size-preview[data-size='md'] {
    font-size: var(--text-xl);
  }

  .font-size-preview[data-size='lg'] {
    font-size: var(--text-2xl);
  }

  .font-size-preview[data-size='xl'] {
    font-size: 1.375rem;
  }

  .toggle-setting {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    cursor: pointer;
  }

  .toggle-setting input[type='checkbox'] {
    width: 1rem;
    height: 1rem;
    cursor: pointer;
  }

  .setting-description {
    font-size: var(--text-md);
    color: var(--color-text-secondary);
    margin: 0.5rem 0 0 0;
  }

  .pds-link {
    display: inline-block;
    margin-top: 0.5rem;
    color: var(--color-primary);
    text-decoration: none;
  }

  .pds-link:hover {
    text-decoration: underline;
  }

  .about-links {
    margin-top: 1rem;
    padding-top: 1rem;
    border-top: 1px solid var(--color-border);
    font-size: var(--text-md);
  }

  .about-links a {
    color: var(--color-text-secondary);
    text-decoration: none;
  }

  .about-links a:hover {
    color: var(--color-primary);
    text-decoration: underline;
  }

  .about-links .separator {
    margin: 0 0.5rem;
    color: var(--color-text-secondary);
  }

  .button-row {
    display: flex;
    gap: 0.75rem;
    flex-wrap: wrap;
  }

  .subhead {
    font-size: var(--text-md);
    font-weight: var(--weight-semibold);
    margin: 1.25rem 0 0.5rem;
  }

  .hint-text {
    font-size: var(--text-sm);
    color: var(--color-text-secondary);
    margin: 0 0 0.5rem;
  }

  .bookmarklet-row {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
    margin-bottom: 0.5rem;
  }

  .bookmarklet {
    display: inline-flex;
    align-items: center;
    padding: 0.45rem 0.85rem;
    border: 1px solid var(--color-primary, #0066cc);
    border-radius: 6px;
    background: var(--color-bg);
    color: var(--color-primary, #0066cc);
    font-size: var(--text-md);
    font-weight: var(--weight-medium);
    text-decoration: none;
    cursor: grab;
  }

  .bookmarklet:active {
    cursor: grabbing;
  }

  .shortcut-steps summary {
    cursor: pointer;
    font-weight: var(--weight-medium);
    color: var(--color-primary);
  }

  .shortcut-steps ol {
    margin: 0.75rem 0;
    padding-left: 1.25rem;
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
    font-size: var(--text-md);
    color: var(--color-text);
  }

  .shortcut-steps code {
    font-family: var(--font-mono, monospace);
    font-size: 0.9em;
    background: var(--color-bg-secondary);
    padding: 0.05em 0.3em;
    border-radius: 4px;
    word-break: break-all;
  }

  .loading {
    color: var(--color-text-secondary);
    font-style: italic;
  }

  .sync-toggle-section {
    margin-top: 1rem;
    padding-top: 1rem;
    border-top: 1px solid var(--color-border);
  }

  .sync-status {
    margin: 1rem 0;
    padding: 0.75rem;
    background: var(--color-bg-secondary);
    border-radius: 6px;
  }

  .sync-time {
    font-size: var(--text-md);
    color: var(--color-text-secondary);
    margin: 0.25rem 0;
  }

  .sync-error {
    color: var(--color-danger);
    font-size: var(--text-md);
    margin-top: 0.5rem;
  }

  .sync-success {
    color: var(--color-success, #22c55e);
    font-size: var(--text-md);
    margin-top: 0.5rem;
  }

  .linkblog-field {
    margin-bottom: 0.875rem;
  }

  .linkblog-field label {
    display: block;
    font-size: var(--text-md);
    margin-bottom: 0.375rem;
    color: var(--color-text-secondary);
  }

  .linkblog-field input,
  .linkblog-field textarea {
    width: 100%;
    padding: 0.5rem 0.625rem;
    border: 1px solid var(--color-border);
    border-radius: 6px;
    background: var(--color-bg);
    color: var(--color-text);
    font: inherit;
    box-sizing: border-box;
  }

  .linkblog-field textarea {
    resize: vertical;
  }

  /* External-backed saves: engine picker */
  .engine-options {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    margin-top: 1rem;
  }

  .engine-option {
    display: flex;
    align-items: flex-start;
    gap: 0.75rem;
    width: 100%;
    text-align: left;
    padding: 0.75rem;
    background: var(--color-bg);
    border: 2px solid var(--color-border);
    border-radius: 8px;
    cursor: pointer;
    transition:
      border-color 0.15s,
      background-color 0.15s;
  }

  .engine-option:hover:not(:disabled) {
    border-color: var(--color-primary);
  }

  .engine-option.selected {
    border-color: var(--color-primary);
    background: var(--color-sidebar-active);
  }

  .engine-option:disabled {
    cursor: default;
    opacity: 0.7;
  }

  .engine-check {
    flex-shrink: 0;
    width: 18px;
    height: 18px;
    margin-top: 0.1rem;
    border: 1.5px solid var(--color-border);
    border-radius: 4px;
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--color-primary);
  }

  .engine-option.selected .engine-check {
    border-color: var(--color-primary);
  }

  .engine-info {
    display: flex;
    flex-direction: column;
    gap: 0.2rem;
    min-width: 0;
  }

  .engine-name {
    font-weight: var(--weight-medium);
    color: var(--color-text);
  }

  .engine-desc {
    font-size: var(--text-md);
    color: var(--color-text-secondary);
  }

  .backing-status {
    margin-top: 1rem;
  }

  .backing-config {
    margin-top: 1rem;
    padding-top: 1rem;
    border-top: 1px solid var(--color-border);
  }

  .config-label {
    font-size: var(--text-md);
    color: var(--color-text-secondary);
    margin: 0 0 0.5rem 0;
  }

  .collection-picker {
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
    margin-bottom: 1rem;
  }

  /* Selectable rows mirror the .engine-option vocabulary used above, so the
     collection list reads as part of the same choice, not a new control. */
  .collection-option {
    position: relative;
    display: flex;
    align-items: center;
    gap: 0.65rem;
    width: 100%;
    padding: 0.55rem 0.7rem;
    background: var(--color-bg);
    border: 1.5px solid var(--color-border);
    border-radius: 8px;
    cursor: pointer;
    transition:
      border-color 0.15s ease,
      background-color 0.15s ease;
  }

  .collection-option:hover {
    border-color: var(--color-primary);
  }

  .collection-option.selected {
    border-color: var(--color-primary);
    background: var(--color-sidebar-active);
  }

  /* Native radio stays present for keyboard + group semantics, visually hidden
     in favor of the custom .collection-radio dot. */
  .collection-option input[type='radio'] {
    position: absolute;
    width: 1px;
    height: 1px;
    opacity: 0;
    pointer-events: none;
  }

  .collection-option:has(input:focus-visible) {
    outline: 2px solid var(--color-primary);
    outline-offset: 1px;
  }

  .collection-radio {
    flex-shrink: 0;
    display: grid;
    place-items: center;
    width: 18px;
    height: 18px;
    border: 1.5px solid var(--color-border);
    border-radius: 50%;
    transition: border-color 0.15s ease;
  }

  .collection-radio::after {
    content: '';
    width: 9px;
    height: 9px;
    border-radius: 50%;
    background: var(--color-primary);
    transform: scale(0);
    transition: transform 0.15s cubic-bezier(0.22, 1, 0.36, 1);
  }

  .collection-option.selected .collection-radio {
    border-color: var(--color-primary);
  }

  .collection-option.selected .collection-radio::after {
    transform: scale(1);
  }

  .collection-glyph {
    flex-shrink: 0;
    display: flex;
    color: var(--color-text-secondary);
    transition: color 0.15s ease;
  }

  .collection-option.is-new.selected .collection-glyph {
    color: var(--color-primary);
  }

  .collection-info {
    display: flex;
    flex-direction: column;
    gap: 0.1rem;
    min-width: 0;
  }

  .collection-name {
    font-size: var(--text-md);
    font-weight: var(--weight-medium);
    color: var(--color-text);
  }

  .collection-meta {
    font-size: var(--text-sm);
    color: var(--color-text-secondary);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .collection-sep {
    height: 1px;
    background: var(--color-border);
    margin: 0.25rem 0;
  }

  .collection-list {
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
    max-height: 14rem;
    overflow-y: auto;
    /* Room so focus outlines on edge rows aren't clipped by the scroll box. */
    padding: 2px;
    margin: -2px;
  }

  .collection-search-wrap {
    position: relative;
    display: flex;
    align-items: center;
  }

  .collection-search-icon {
    position: absolute;
    left: 0.6rem;
    display: flex;
    color: var(--color-text-secondary);
    pointer-events: none;
  }

  .collection-search {
    width: 100%;
    padding: 0.45rem 0.6rem 0.45rem 2rem;
    font-size: var(--text-md);
    color: var(--color-text);
    background: var(--color-bg);
    border: 1px solid var(--color-border);
    border-radius: 6px;
    transition: border-color 0.15s ease;
  }

  .collection-search:focus {
    outline: none;
    border-color: var(--color-primary);
  }

  .collection-empty {
    font-size: var(--text-md);
    color: var(--color-text-secondary);
    text-align: center;
    padding: 0.85rem 0.5rem;
    margin: 0;
  }

  .collection-more {
    font-size: var(--text-sm);
    color: var(--color-text-secondary);
    margin: 0.1rem 0 0 0;
  }

  @media (prefers-reduced-motion: reduce) {
    .collection-option,
    .collection-radio,
    .collection-radio::after,
    .collection-glyph,
    .collection-search {
      transition: none;
    }
  }

  .backing-warning {
    font-size: var(--text-md);
    color: var(--color-text);
    background: var(--color-bg-secondary);
    border: 1px solid var(--color-border);
    border-radius: 6px;
    padding: 0.75rem;
    margin-bottom: 1rem;
  }

  .backing-warning strong {
    color: var(--color-warning);
  }

  .export-toggle {
    margin-bottom: 1rem;
  }

  .backing-actions {
    display: flex;
    gap: 0.5rem;
  }

  .export-progress {
    margin-top: 0.75rem;
  }

  .progress-track {
    height: 8px;
    background: var(--color-border);
    border-radius: 4px;
    overflow: hidden;
    margin: 0.5rem 0;
  }

  /* Scale a full-width bar on the X axis (transform, not width) so the fill animates
     without layout thrash. transform-origin keeps it growing from the left. */
  .progress-bar-fill {
    height: 100%;
    width: 100%;
    transform-origin: left center;
    background: var(--color-primary);
    transition: transform 0.2s ease;
  }

  .progress-count {
    margin: 0;
    color: var(--color-text-secondary);
    font-size: var(--text-sm);
    font-variant-numeric: tabular-nums;
  }
</style>
