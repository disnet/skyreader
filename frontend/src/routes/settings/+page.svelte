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
    type DefaultView,
    ARTICLE_FONT_SIZE_MIN,
    ARTICLE_FONT_SIZE_MAX,
  } from '$lib/stores/preferences.svelte';
  import ImportOPMLModal from '$lib/components/ImportOPMLModal.svelte';
  import SaveBackingPicker from '$lib/components/settings/SaveBackingPicker.svelte';
  import StaticPageChrome from '$lib/components/feed/StaticPageChrome.svelte';
  import { downloadOPML } from '$lib/utils/opml-exporter';
  import { api, RateLimitError } from '$lib/services/api';
  import { syncStore } from '$lib/stores/sync.svelte';
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

  const defaultViewOptions: { value: DefaultView; label: string }[] = [
    { value: 'home', label: 'Home' },
    { value: 'feeds', label: 'Feeds' },
    { value: 'saved', label: 'Saved' },
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

  // External-backed saves: which engine holds the Saved list. Owned/managed by
  // <SaveBackingPicker bind:backing>; kept here so the "Privacy & sharing" overview
  // and the Saved-articles badge can reflect public/private state.
  let backing = $state<SaveBacking>({ provider: 'skyreader' });

  // Live public/private state for the "Privacy & sharing" overview and per-section badges.
  // Saves are public once a foreign-collection backing engine (Semble/Margin) is on.
  const savesPublic = $derived(backing.provider !== 'skyreader');

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
      goto('/feeds');
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

{#snippet visBadge(isPublic: boolean)}
  <span
    class="vis-badge"
    class:public={isPublic}
    title={isPublic ? 'Anyone can see this' : 'Only you, on Skyreader'}
  >
    {isPublic ? 'Public' : 'Private'}
  </span>
{/snippet}

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

  <!-- Privacy & sharing: at-a-glance overview of what's public vs private -->
  <section class="card">
    <h2>Privacy &amp; sharing</h2>
    <p class="setting-description" style="margin-top: 0;">
      Your reading is private to you on Skyreader by default. A few things are public, or can be
      made public, so they're portable across the Atmosphere. Here's where each one stands.
    </p>
    {#if isSyncLoading}
      <p class="loading">Loading…</p>
    {:else}
      <ul class="vis-overview">
        <li><span class="vis-row-label">Subscriptions</span>{@render visBadge(pdsSyncEnabled)}</li>
        <li><span class="vis-row-label">Saved articles</span>{@render visBadge(savesPublic)}</li>
        <li><span class="vis-row-label">Shared links</span>{@render visBadge(true)}</li>
      </ul>
      {#if auth.user}
        <a
          href="https://pdsls.dev/at://{auth.user.did}"
          target="_blank"
          rel="noopener noreferrer"
          class="pds-link">View your public PDS data</a
        >
      {/if}
    {/if}
  </section>

  <!-- Subscriptions -->
  <section class="card">
    <div class="card-head">
      <h2>Subscriptions</h2>
      {@render visBadge(pdsSyncEnabled)}
    </div>
    <p class="setting-description" style="margin-top: 0;">
      Your feed list is private, stored on Skyreader. Turn on Atmospheric sync to also store it on
      your PDS, where it's backed up, portable to any Atmospheric app, and publicly visible. Your
      standard.site follows stay in step either way: follow or unfollow in either place and the
      other follows along.
    </p>

    {#if isSyncLoading}
      <p class="loading">Loading sync settings...</p>
    {:else}
      <div class="sync-toggle-section">
        <label class="toggle-setting">
          <input type="checkbox" checked={pdsSyncEnabled} onchange={handleTogglePdsSync} />
          <span>Turn on Atmospheric sync</span>
        </label>
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

  <!-- Saved articles -->
  <section class="card">
    <div class="card-head">
      <h2>Saved articles</h2>
      {@render visBadge(savesPublic)}
    </div>
    <p class="setting-description" style="margin-top: 0;">
      Your saves stay private on Skyreader. To turn your whole Saved list into a collection you can
      edit in another app, back it with Semble or Margin. That collection is public. You can change
      this anytime.
    </p>

    <SaveBackingPicker bind:backing allowExport returnUrl="/settings" />
  </section>

  <!-- Shared links -->
  <section class="card">
    <div class="card-head">
      <h2>Shared links</h2>
      {@render visBadge(true)}
    </div>
    <p class="setting-description" style="margin-top: 0;">
      Sharing an article publishes it to your <strong>linkblog</strong>, a public publication in
      your PDS that's readable across the Atmosphere. Anyone with the link can read it.
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
      <div class="font-size-control">
        <button
          class="size-step"
          onclick={() => preferences.decreaseFontSize()}
          disabled={preferences.articleFontSize <= ARTICLE_FONT_SIZE_MIN}
          aria-label="Decrease font size"
        >
          <span class="size-glyph size-glyph-sm">A</span>
        </button>
        <span class="size-readout">{preferences.articleFontSize}<small>px</small></span>
        <button
          class="size-step"
          onclick={() => preferences.increaseFontSize()}
          disabled={preferences.articleFontSize >= ARTICLE_FONT_SIZE_MAX}
          aria-label="Increase font size"
        >
          <span class="size-glyph size-glyph-lg">A</span>
        </button>
      </div>
    </div>
  </section>

  <section class="card">
    <h2>Reading</h2>
    <div class="setting-row">
      <label for="default-view">When you open the app</label>
      <div class="font-options">
        {#each defaultViewOptions as option}
          <button
            class="view-option"
            class:selected={preferences.defaultView === option.value}
            onclick={() => preferences.setDefaultView(option.value)}
          >
            {option.label}
          </button>
        {/each}
      </div>
    </div>
    <p class="setting-description">Choose which view loads first when you open Skyreader.</p>
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
      Your reading lives on Skyreader and stays private by default. You can make much of it portable
      across the Atmosphere, stored on your own Personal Data Server (PDS). See
      <strong>Privacy &amp; sharing</strong> above for what's public.
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

  .view-option {
    padding: 0.5rem 1rem;
    background: var(--color-bg);
    border: 2px solid var(--color-border);
    border-radius: 8px;
    color: var(--color-text-secondary);
    font-size: var(--text-md);
    font-weight: var(--weight-medium);
    cursor: pointer;
    transition:
      border-color 0.15s,
      background-color 0.15s,
      color 0.15s;
  }

  .view-option:hover {
    border-color: var(--color-primary);
  }

  .view-option.selected {
    border-color: var(--color-primary);
    background: var(--color-sidebar-active);
    color: var(--color-primary);
  }

  .font-size-control {
    display: inline-flex;
    align-items: center;
    gap: 0.5rem;
  }

  .size-step {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 2.75rem;
    height: 2.75rem;
    background: var(--color-bg);
    border: 2px solid var(--color-border);
    border-radius: 8px;
    cursor: pointer;
    color: var(--color-text);
    transition:
      border-color 0.15s,
      background-color 0.15s;
  }

  .size-step:hover:not(:disabled) {
    border-color: var(--color-primary);
  }

  .size-step:disabled {
    opacity: 0.4;
    cursor: default;
  }

  .size-glyph {
    line-height: var(--leading-none);
    font-weight: var(--weight-semibold);
  }

  .size-glyph-sm {
    font-size: var(--text-md);
  }

  .size-glyph-lg {
    font-size: var(--text-2xl);
  }

  .size-readout {
    min-width: 3.25rem;
    text-align: center;
    font-size: var(--text-xl);
    font-weight: var(--weight-semibold);
    color: var(--color-text);
    font-variant-numeric: tabular-nums;
  }

  .size-readout small {
    font-size: var(--text-xs);
    font-weight: var(--weight-medium);
    color: var(--color-text-secondary);
    margin-left: 0.1rem;
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

  /* Card header with a visibility badge aligned to the heading. Mirrors the
     h2 underline so badge'd cards read the same as plain ones. */
  .card-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
    margin-bottom: 1rem;
    padding-bottom: 0.5rem;
    border-bottom: 1px solid var(--color-border);
  }

  .card-head h2 {
    margin-bottom: 0;
    padding-bottom: 0;
    border-bottom: none;
  }

  /* Visibility badge. Neutral = private (only you); amber = public (anyone can
     see it). Never blue — blue is reserved for interaction (One Blue). */
  .vis-badge {
    flex-shrink: 0;
    display: inline-flex;
    align-items: center;
    font-size: var(--text-xs);
    font-weight: var(--weight-semibold);
    text-transform: uppercase;
    letter-spacing: var(--tracking-wider);
    padding: 0.15rem 0.5rem;
    border-radius: 6px;
    background: var(--color-bg-secondary);
    color: var(--color-text-secondary);
    white-space: nowrap;
  }

  .vis-badge.public {
    background: color-mix(in srgb, var(--color-warning) 16%, var(--color-bg));
    color: var(--color-warning);
  }

  .vis-overview {
    list-style: none;
    margin: 1rem 0 0;
    padding: 0;
  }

  .vis-overview li {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
    padding: 0.6rem 0;
    border-bottom: 1px solid var(--color-border);
  }

  .vis-overview li:last-child {
    border-bottom: none;
  }

  .vis-row-label {
    font-size: var(--text-md);
    color: var(--color-text);
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
</style>
