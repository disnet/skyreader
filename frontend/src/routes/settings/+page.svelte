<script lang="ts">
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { auth } from '$lib/stores/auth.svelte';
  import { syncStore } from '$lib/stores/sync.svelte';
  import { subscriptionsStore } from '$lib/stores/subscriptions.svelte';
  import { preferences, type ArticleFont, type ArticleFontSize } from '$lib/stores/preferences.svelte';
  import ImportOPMLModal from '$lib/components/ImportOPMLModal.svelte';

  const fontOptions: { value: ArticleFont; label: string }[] = [
    { value: 'sans-serif', label: 'Sans Serif' },
    { value: 'serif', label: 'Serif' },
    { value: 'mono', label: 'Monospace' },
  ];

  const fontSizeOptions: { value: ArticleFontSize; label: string }[] = [
    { value: 'small', label: 'Small' },
    { value: 'medium', label: 'Medium' },
    { value: 'large', label: 'Large' },
  ];

  let showImportModal = $state(false);
  let isRefreshingMetadata = $state(false);
  let refreshProgress = $state({ current: 0, total: 0 });
  let refreshResult = $state<{ updated: number; failed: number } | null>(null);

  onMount(async () => {
    if (!auth.isAuthenticated) {
      goto('/auth/login?returnUrl=/settings');
      return;
    }
    // Load subscriptions if not already loaded
    if (subscriptionsStore.subscriptions.length === 0) {
      await subscriptionsStore.load();
    }
  });

  async function handleLogout() {
    if (confirm('Are you sure you want to log out?')) {
      await auth.logout();
      goto('/');
    }
  }

  async function handleRefreshMetadata() {
    if (isRefreshingMetadata) return;

    isRefreshingMetadata = true;
    refreshResult = null;
    const subs = subscriptionsStore.subscriptions;
    refreshProgress = { current: 0, total: subs.length };

    let updated = 0;
    let failed = 0;

    for (const sub of subs) {
      if (!sub.id) continue;

      try {
        const feed = await subscriptionsStore.fetchFeed(sub.id, true);
        if (feed && (feed.title !== sub.title || feed.siteUrl !== sub.siteUrl)) {
          await subscriptionsStore.update(sub.id, {
            title: feed.title,
            siteUrl: feed.siteUrl,
          });
          updated++;
        }
      } catch (e) {
        console.error(`Failed to refresh metadata for ${sub.feedUrl}:`, e);
        failed++;
      }

      refreshProgress = { current: refreshProgress.current + 1, total: subs.length };
    }

    refreshResult = { updated, failed };
    isRefreshingMetadata = false;
  }

  let isUnsubscribingAll = $state(false);
  let unsubscribeProgress = $state({ current: 0, total: 0 });

  async function handleUnsubscribeAll() {
    const count = subscriptionsStore.subscriptions.length;
    if (count === 0) return;

    if (!confirm(`Are you sure you want to unsubscribe from all ${count} feeds? This cannot be undone.`)) {
      return;
    }

    isUnsubscribingAll = true;
    unsubscribeProgress = { current: 0, total: count };

    // Get a copy of IDs since array will change as we delete
    const ids = subscriptionsStore.subscriptions.map(s => s.id).filter((id): id is number => id !== undefined);

    for (const id of ids) {
      await subscriptionsStore.remove(id);
      unsubscribeProgress = { current: unsubscribeProgress.current + 1, total: count };
    }

    isUnsubscribingAll = false;
  }
</script>

<div class="settings-page">
  <h1>Settings</h1>

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
      <button class="btn btn-danger" onclick={handleLogout}>
        Log Out
      </button>
    </section>
  {/if}

  <section class="card">
    <h2>Sync Status</h2>
    <dl class="status-list">
      <dt>Connection</dt>
      <dd>
        <span class="status-badge" class:online={syncStore.isOnline} class:offline={!syncStore.isOnline}>
          {syncStore.isOnline ? 'Online' : 'Offline'}
        </span>
      </dd>
      <dt>Pending Changes</dt>
      <dd>{syncStore.pendingCount}</dd>
      {#if syncStore.lastSyncedAt}
        <dt>Last Sync</dt>
        <dd>{new Date(syncStore.lastSyncedAt).toLocaleTimeString()}</dd>
      {/if}
    </dl>
    <button class="btn btn-secondary" onclick={() => syncStore.triggerSync()} disabled={!syncStore.isOnline}>
      Sync Now
    </button>
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
            <span class="font-preview" style:font-family={option.value === 'mono' ? 'monospace' : option.value}>Aa</span>
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
            <span class="font-size-preview" class:small={option.value === 'small'} class:large={option.value === 'large'}>Aa</span>
            <span class="font-label">{option.label}</span>
          </button>
        {/each}
      </div>
    </div>
  </section>

  <section class="card">
    <h2>Feeds</h2>
    <p>Refresh feed titles and icons from their sources. This will update your PDS with the correct metadata.</p>
    <div class="refresh-section">
      <button
        class="btn btn-secondary"
        onclick={handleRefreshMetadata}
        disabled={isRefreshingMetadata || subscriptionsStore.subscriptions.length === 0}
      >
        {#if isRefreshingMetadata}
          Refreshing... ({refreshProgress.current}/{refreshProgress.total})
        {:else}
          Refresh All Metadata
        {/if}
      </button>
      {#if refreshResult}
        <p class="refresh-result">
          Updated {refreshResult.updated} feed{refreshResult.updated !== 1 ? 's' : ''}{#if refreshResult.failed > 0}, {refreshResult.failed} failed{/if}
        </p>
      {/if}
    </div>
  </section>

  <section class="card">
    <h2>Import / Export</h2>
    <p>Import feeds from other RSS readers using OPML files.</p>
    <button class="btn btn-secondary" onclick={() => showImportModal = true}>
      Import OPML
    </button>
  </section>

  <section class="card">
    <h2>About</h2>
    <p>Skyreader is a decentralized RSS reader built on the AT Protocol.</p>
    <p>Your data is stored in your Personal Data Server (PDS), giving you full ownership and portability.</p>
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
        Unsubscribing... ({unsubscribeProgress.current}/{unsubscribeProgress.total})
      {:else}
        Unsubscribe from All ({subscriptionsStore.subscriptions.length} feeds)
      {/if}
    </button>
  </section>
</div>

<ImportOPMLModal open={showImportModal} onclose={() => showImportModal = false} />

<style>
  .settings-page {
    max-width: 600px;
    margin: 0 auto;
  }

  .settings-page h1 {
    margin-bottom: 1.5rem;
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

  .status-list {
    display: grid;
    grid-template-columns: auto 1fr;
    gap: 0.5rem 1rem;
    margin-bottom: 1rem;
  }

  .status-list dt {
    font-weight: 500;
  }

  .status-badge {
    display: inline-block;
    padding: 0.125rem 0.5rem;
    border-radius: 4px;
    font-size: 0.75rem;
  }

  .status-badge.online {
    background: var(--color-success);
    color: white;
  }

  .status-badge.offline {
    background: var(--color-error);
    color: white;
  }

  .refresh-section {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    align-items: flex-start;
  }

  .refresh-result {
    font-size: 0.875rem;
    color: var(--color-text-secondary);
    margin: 0;
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
    transition: border-color 0.15s, background-color 0.15s;
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
    transition: border-color 0.15s, background-color 0.15s;
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
    font-size: 1.25rem;
    line-height: 1;
  }

  .font-size-preview.small {
    font-size: 1rem;
  }

  .font-size-preview.large {
    font-size: 1.5rem;
  }
</style>
