<script lang="ts">
  import { onMount } from 'svelte';
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
  import FeedPageHeader from '$lib/components/feed/FeedPageHeader.svelte';
  import MobileBottomBar from '$lib/components/feed/MobileBottomBar.svelte';
  import MobileFeedSwitcher from '$lib/components/feed/MobileFeedSwitcher.svelte';
  import BottomSheet from '$lib/components/common/BottomSheet.svelte';
  import { mobileStore } from '$lib/stores/mediaQuery.svelte';
  import { downloadOPML } from '$lib/utils/opml-exporter';
  import { api, RateLimitError } from '$lib/services/api';
  import { syncStore } from '$lib/stores/sync.svelte';
  import { viewTitleStore } from '$lib/stores/viewTitle.svelte';
  import type { LinkblogPublication } from '$lib/types';

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
  let feedSwitcherOpen = $state(false);

  // PDS Sync state
  let pdsSyncEnabled = $state(false);
  let lastSyncSubscriptions = $state<number | null>(null);
  let isSyncLoading = $state(false);
  let isSyncing = $state(false);
  let syncError = $state<string | null>(null);
  let syncSuccess = $state<string | null>(null);

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

<FeedPageHeader title="Settings" hideControls />

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

  {#if mobileStore.isMobile}
    <MobileBottomBar
      controlsVisible={true}
      currentTitle="Settings"
      onScrollToTop={() => window.scrollTo({ top: 0, behavior: 'smooth' })}
      onOpenFeedSwitcher={() => (feedSwitcherOpen = true)}
      onOpenFilterSheet={() => {}}
      hasActiveFilters={false}
      hideFilterButton
    />

    <BottomSheet
      open={feedSwitcherOpen}
      onclose={() => (feedSwitcherOpen = false)}
      title="Switch Feed"
    >
      <MobileFeedSwitcher onclose={() => (feedSwitcherOpen = false)} currentTitle="Settings" />
    </BottomSheet>
  {/if}
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
</style>
