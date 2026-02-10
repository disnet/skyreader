<script lang="ts">
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { auth } from '$lib/stores/auth.svelte';
  import { subscriptionsStore } from '$lib/stores/subscriptions.svelte';
  import {
    preferences,
    type ArticleFont,
    type ArticleFontSize,
  } from '$lib/stores/preferences.svelte';
  import ImportOPMLModal from '$lib/components/ImportOPMLModal.svelte';
  import PageHeader from '$lib/components/common/PageHeader.svelte';
  import { downloadOPML } from '$lib/utils/opml-exporter';
  import { api, RateLimitError } from '$lib/services/api';
  import { viewTitleStore } from '$lib/stores/viewTitle.svelte';

  $effect(() => {
    viewTitleStore.set('Settings');
    return () => viewTitleStore.set('');
  });

  const fontOptions: { value: ArticleFont; label: string }[] = [
    { value: 'sans-serif', label: 'Sans Serif' },
    { value: 'serif', label: 'Serif' },
    { value: 'mono', label: 'Monospace' },
  ];

  const fontSizeOptions: { value: ArticleFontSize; label: string }[] = [
    { value: 'xs', label: 'XS' },
    { value: 'sm', label: 'S' },
    { value: 'md', label: 'M' },
    { value: 'lg', label: 'L' },
    { value: 'xl', label: 'XL' },
  ];

  let showImportModal = $state(false);

  // PDS Sync state
  let pdsSyncEnabled = $state(false);
  let lastSyncSubscriptions = $state<number | null>(null);
  let isSyncLoading = $state(false);
  let isSyncing = $state(false);
  let syncError = $state<string | null>(null);
  let syncSuccess = $state<string | null>(null);

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
  });

  async function loadSyncSettings() {
    isSyncLoading = true;
    try {
      const settings = await api.getSettings();
      pdsSyncEnabled = settings.pdsSyncEnabled;
      lastSyncSubscriptions = settings.lastPdsSyncSubscriptions;
    } catch (error) {
      console.error('Failed to load sync settings:', error);
    } finally {
      isSyncLoading = false;
    }
  }

  async function handleTogglePdsSync(event: Event) {
    const target = event.currentTarget as HTMLInputElement;
    const newValue = target.checked;

    syncError = null;
    syncSuccess = null;

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

    isSyncing = true;
    syncError = null;
    syncSuccess = null;

    // Track totals across multiple sync calls (for batched hasMore syncs)
    let totalPulled = 0;
    let totalPushed = 0;
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

        if (!result.success) {
          syncError = result.error || 'Sync failed';
          return;
        }

        // Accumulate totals
        totalPulled += result.subscriptions?.pulledFromPds || 0;
        totalPushed += result.subscriptions?.pushedToPds || 0;

        // Collect warnings
        allWarnings = [...allWarnings, ...(result.subscriptions?.warnings || [])];

        // Check if there's more to sync
        hasMore = result.hasMore || false;
      }

      syncSuccess = `Sync complete: ${totalPulled} pulled, ${totalPushed} pushed`;
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

<div class="settings-page">
  <PageHeader title="Settings" />

  {#if auth.user}
    <section class="card">
      <h2>Account</h2>
      <div class="user-info">
        {#if auth.user.avatarUrl}
          <img src={auth.user.avatarUrl} alt="" class="avatar" />
        {/if}
        <div>
          <p class="display-name">{auth.user.displayName || auth.user.handle}</p>
          <p class="handle">@{auth.user.handle}</p>
          <p class="did">{auth.user.did}</p>
        </div>
      </div>
      <button class="btn btn-danger" onclick={handleLogout}> Log Out </button>
    </section>
  {/if}

  <section class="card">
    <h2>Data Portability</h2>
    <p class="setting-description" style="margin-top: 0;">
      Your <strong>shares are always stored</strong> in your Personal Data Server (PDS). This makes
      them publicly visible and portable to any AT Protocol compatible service.
      {#if auth.user}
        <a
          href="https://pdsls.dev/at://{auth.user.did}"
          target="_blank"
          rel="noopener noreferrer"
          class="pds-link">View your public PDS data</a
        >
      {/if}
    </p>

    {#if isSyncLoading}
      <p class="loading">Loading sync settings...</p>
    {:else}
      <div class="sync-toggle-section">
        <label class="toggle-setting">
          <input type="checkbox" checked={pdsSyncEnabled} onchange={handleTogglePdsSync} />
          <span>Also sync subscriptions</span>
        </label>
        <p class="setting-description">
          Optionally store your feed subscriptions in your PDS. Note: this data will be <strong
            >publicly visible</strong
          > on your PDS, but gives you full backup and portability.
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
            <span
              class="font-preview"
              style:font-family={option.value === 'mono' ? 'monospace' : option.value}>Aa</span
            >
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
    <p>Import or export your subscriptions using OPML files.</p>
    <div class="button-row">
      <button class="btn btn-secondary" onclick={() => (showImportModal = true)}>
        Import OPML
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

  <section class="card">
    <h2>About</h2>
    <p>Skyreader is a decentralized RSS reader built on the AT Protocol.</p>
    <p>
      Your data is stored in your Personal Data Server (PDS), making it portable and under your
      control.
    </p>
    <div class="about-links">
      <a href="/terms">Terms of Service</a>
      <span class="separator">·</span>
      <a href="mailto:abuse@skyreader.app">Report Abuse</a>
      <span class="separator">·</span>
      <a href="https://github.com/disnet/skyreader/issues" target="_blank" rel="noopener noreferrer"
        >Feedback</a
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
  }

  section {
    margin-bottom: 1.5rem;
  }

  section h2 {
    font-size: 1.125rem;
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
    font-weight: 600;
  }

  .handle {
    color: var(--color-text-secondary);
  }

  .did {
    font-size: 0.75rem;
    color: var(--color-text-secondary);
    word-break: break-all;
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
    font-weight: 500;
    color: var(--color-text-secondary);
    font-size: 0.875rem;
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
    font-size: 1.5rem;
    line-height: 1;
  }

  .font-label {
    font-size: 0.75rem;
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
    line-height: 1;
  }

  .font-size-preview[data-size='xs'] {
    font-size: 0.875rem;
  }

  .font-size-preview[data-size='sm'] {
    font-size: 1rem;
  }

  .font-size-preview[data-size='md'] {
    font-size: 1.125rem;
  }

  .font-size-preview[data-size='lg'] {
    font-size: 1.25rem;
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
    font-size: 0.875rem;
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
    font-size: 0.875rem;
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
    font-size: 0.875rem;
    color: var(--color-text-secondary);
    margin: 0.25rem 0;
  }

  .sync-error {
    color: var(--color-danger);
    font-size: 0.875rem;
    margin-top: 0.5rem;
  }

  .sync-success {
    color: var(--color-success, #22c55e);
    font-size: 0.875rem;
    margin-top: 0.5rem;
  }
</style>
