<script lang="ts">
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { page } from '$app/stores';
  import { auth } from '$lib/stores/auth.svelte';
  import { subscriptionsStore } from '$lib/stores/subscriptions.svelte';
  import { api, ScopeUpgradeError } from '$lib/services/api';
  import Logo from '$lib/assets/logo.svg';
  import Icon from '$lib/components/Icon.svelte';

  // Lightweight share-target / bookmarklet endpoint for subscribing. An Apple
  // Shortcut (or bookmarklet, or future PWA share_target) opens
  //   https://skyreader.app/subscribe?url=<percent-encoded page URL>
  // and this page runs the same discovery + add the in-app Add Feed modal uses,
  // reusing the browser's existing session cookie — no token needed.

  interface StandardSite {
    did: string;
    publicationUri: string;
    name: string;
    url?: string;
    description?: string;
    iconUrl?: string;
  }

  type Status = 'working' | 'select' | 'success' | 'already' | 'invalid' | 'scope' | 'error';

  let status = $state<Status>('working');
  let isSubscribing = $state(false);
  let discoveredFeeds = $state<string[]>([]);
  let standardSite = $state<StandardSite | null>(null);
  let successTitle = $state<string>('');
  let successId = $state<number | null>(null);
  let errorMessage = $state<string | null>(null);

  // The page/feed URL from the query string. searchParams decodes once; we
  // normalize a bare domain to https:// like the Add Feed modal does.
  function readUrl(): string | null {
    const raw = $page.url.searchParams.get('url');
    if (!raw) return null;
    let u = raw.trim();
    if (!u) return null;
    if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
    try {
      const parsed = new URL(u);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
      return u;
    } catch {
      return null;
    }
  }

  async function run() {
    const url = readUrl();
    if (!url) {
      status = 'invalid';
      return;
    }

    // Not logged in → send to login, then come back here. Re-encode the URL into
    // the returnUrl so the path carries no literal "//" (the backend's
    // open-redirect guard drops relative returnUrls containing "//").
    if (!auth.isAuthenticated) {
      const returnUrl = `/subscribe?url=${encodeURIComponent(url)}`;
      await goto(`/auth/login?returnUrl=${encodeURIComponent(returnUrl)}`);
      return;
    }

    try {
      // Populate the local subscription cache so duplicate/limit checks in
      // `add()` are accurate even though the app shell never booted here.
      await subscriptionsStore.load();

      const result = await api.discoverFeedsV2(url);
      const site = result.standardSite ?? null;
      const feeds = result.feeds;
      // standard.site is the preferred option, so it counts ahead of RSS feeds.
      const candidateCount = (site ? 1 : 0) + feeds.length;

      if (candidateCount === 0) {
        errorMessage = 'No feeds found at this page.';
        status = 'error';
      } else if (candidateCount === 1) {
        if (site) {
          await addStandardSite(site);
        } else {
          await addFeed(feeds[0]);
        }
      } else {
        standardSite = site;
        discoveredFeeds = feeds;
        status = 'select';
      }
    } catch (err) {
      handleError(err);
    }
  }

  function handleError(err: unknown) {
    if (err instanceof ScopeUpgradeError) {
      status = 'scope';
      return;
    }
    const msg = err instanceof Error ? err.message : 'Something went wrong';
    if (/already subscribed/i.test(msg)) {
      status = 'already';
      return;
    }
    errorMessage = msg;
    status = 'error';
  }

  async function addFeed(feedUrl: string) {
    if (isSubscribing) return;
    isSubscribing = true;
    try {
      const title = new URL(feedUrl).hostname;
      const id = await subscriptionsStore.add(feedUrl, title, {});
      // Leave content fetching + title refinement to the app's normal refresh
      // cycle, which runs when the user opens Skyreader.
      successTitle = title;
      successId = id;
      status = 'success';
    } catch (err) {
      handleError(err);
    } finally {
      isSubscribing = false;
    }
  }

  async function addStandardSite(site: StandardSite) {
    if (isSubscribing) return;
    isSubscribing = true;
    try {
      const id = await subscriptionsStore.add(site.publicationUri, site.name, {
        sourceType: 'atproto.documents',
        subjectDid: site.did,
        siteUrl: site.url,
        feedUrl: site.publicationUri,
      });
      if (site.iconUrl) {
        try {
          await subscriptionsStore.updateLocal(id, { customIconUrl: site.iconUrl });
        } catch {
          // Non-fatal: the icon resolves on the next sync.
        }
      }
      successTitle = site.name;
      successId = id;
      status = 'success';
    } catch (err) {
      handleError(err);
    } finally {
      isSubscribing = false;
    }
  }

  async function openInApp() {
    if (successId != null) {
      await goto(`/feeds?feed=${successId}`);
    } else {
      await goto('/feeds');
    }
  }

  const loginReturnUrl = $derived.by(() => {
    const url = readUrl();
    return url
      ? `/auth/login?returnUrl=${encodeURIComponent(`/subscribe?url=${encodeURIComponent(url)}`)}`
      : '/auth/login';
  });

  onMount(run);
</script>

<svelte:head>
  <title>Subscribe in Skyreader</title>
</svelte:head>

<div class="subscribe-page">
  <div class="card">
    <img src={Logo} alt="" class="logo" />

    {#if status === 'working'}
      <div class="spinner" aria-hidden="true"></div>
      <p class="title">Finding feeds…</p>
      <p class="sub">{readUrl() ?? ''}</p>
    {:else if status === 'select'}
      <p class="title">Multiple feeds found</p>
      <p class="sub">Choose one to subscribe:</p>
      <div class="options">
        {#if standardSite}
          <button
            class="option standard"
            onclick={() => standardSite && addStandardSite(standardSite)}
            disabled={isSubscribing}
          >
            {#if standardSite.iconUrl}
              <img class="option-icon" src={standardSite.iconUrl} alt="" />
            {/if}
            <span class="option-info">
              <span class="option-name">
                {standardSite.name}
                <span class="badge"><Icon name="standard-site" size={11} />standard.site</span>
              </span>
              {#if standardSite.url}
                <span class="option-url">{standardSite.url}</span>
              {/if}
            </span>
          </button>
        {/if}
        {#each discoveredFeeds as feedUrl (feedUrl)}
          <button class="option" onclick={() => addFeed(feedUrl)} disabled={isSubscribing}>
            <span class="option-info">
              <span class="option-url">{feedUrl}</span>
            </span>
          </button>
        {/each}
      </div>
    {:else if status === 'success'}
      <div class="check" aria-hidden="true">✓</div>
      <p class="title">Subscribed</p>
      <p class="sub">{successTitle}</p>
      <button class="btn-primary" onclick={openInApp}>Open in Skyreader</button>
      <p class="hint">You can close this tab and return to your browser.</p>
    {:else if status === 'already'}
      <div class="check" aria-hidden="true">✓</div>
      <p class="title">Already subscribed</p>
      <p class="sub">This feed is already in your Skyreader.</p>
      <a class="btn-primary" href="/">Open Skyreader</a>
    {:else if status === 'invalid'}
      <p class="title">No page to subscribe to</p>
      <p class="sub">This page needs a <code>?url=</code> link. Try sharing again.</p>
      <a class="btn-secondary" href="/">Go to Skyreader</a>
    {:else if status === 'scope'}
      <p class="title">Log in again to subscribe</p>
      <p class="sub">Subscribing needs updated permissions for your account.</p>
      <a class="btn-primary" href={loginReturnUrl}>Log in again</a>
    {:else}
      <p class="title">Couldn't subscribe</p>
      <p class="sub">{errorMessage}</p>
      <a class="btn-secondary" href="/">Go to Skyreader</a>
    {/if}
  </div>
</div>

<style>
  .subscribe-page {
    min-height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 1.5rem;
    background: var(--color-bg, #fff);
  }

  .card {
    width: 100%;
    max-width: 380px;
    display: flex;
    flex-direction: column;
    align-items: center;
    text-align: center;
    gap: 0.75rem;
  }

  .logo {
    width: 48px;
    height: 48px;
    margin-bottom: 0.25rem;
  }

  .title {
    margin: 0;
    font-size: var(--text-xl);
    font-weight: var(--weight-semibold);
    color: var(--color-text);
  }

  .sub {
    margin: 0;
    font-size: var(--text-md);
    color: var(--color-text-secondary);
    word-break: break-word;
    line-height: 1.45;
  }

  .hint {
    margin: 0.25rem 0 0;
    font-size: var(--text-sm);
    color: var(--color-text-secondary);
  }

  code {
    font-family: var(--font-mono, monospace);
    font-size: 0.9em;
    background: var(--color-bg-secondary);
    padding: 0.05em 0.3em;
    border-radius: 4px;
  }

  .check {
    width: 44px;
    height: 44px;
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: 50%;
    background: var(--color-primary, #0066cc);
    color: white;
    font-size: 1.5rem;
    line-height: 1;
  }

  .spinner {
    width: 32px;
    height: 32px;
    border: 3px solid var(--color-border, #e0e0e0);
    border-top-color: var(--color-primary, #0066cc);
    border-radius: 50%;
    animation: spin 0.7s linear infinite;
  }

  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }

  .options {
    width: 100%;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    margin-top: 0.5rem;
  }

  .option {
    display: flex;
    align-items: center;
    gap: 0.625rem;
    width: 100%;
    padding: 0.625rem 0.75rem;
    border: 1px solid var(--color-border, #ddd);
    border-radius: 8px;
    background: var(--color-bg, #fff);
    color: var(--color-text);
    cursor: pointer;
    text-align: left;
    transition: background-color 0.15s;
  }

  .option:hover:not(:disabled) {
    background: var(--color-bg-secondary);
  }

  .option:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .option.standard {
    border-color: var(--color-primary, #0066cc);
    background: color-mix(in srgb, var(--color-primary, #0066cc) 8%, transparent);
  }

  .option.standard:hover:not(:disabled) {
    background: color-mix(in srgb, var(--color-primary, #0066cc) 14%, transparent);
  }

  .option-icon {
    width: 24px;
    height: 24px;
    border-radius: 6px;
    object-fit: cover;
    flex-shrink: 0;
  }

  .option-info {
    display: flex;
    flex-direction: column;
    min-width: 0;
  }

  .option-name {
    font-weight: var(--weight-medium);
    font-size: var(--text-md);
  }

  .option-url {
    font-size: var(--text-sm);
    color: var(--color-text-secondary);
    word-break: break-all;
  }

  .badge {
    display: inline-flex;
    align-items: center;
    gap: 0.2rem;
    margin-left: 0.4rem;
    padding: 0.05rem 0.4rem;
    border-radius: 999px;
    background: var(--color-primary, #0066cc);
    color: white;
    font-size: var(--text-2xs);
    font-weight: var(--weight-semibold);
    vertical-align: middle;
  }

  .btn-primary,
  .btn-secondary {
    margin-top: 0.5rem;
    padding: 0.625rem 1.25rem;
    border-radius: 6px;
    font-size: var(--text-md);
    font-weight: var(--weight-medium);
    text-decoration: none;
    cursor: pointer;
    border: 1px solid transparent;
  }

  .btn-primary {
    background: var(--color-primary, #0066cc);
    color: white;
    border: none;
  }

  .btn-primary:hover {
    background: var(--color-primary-dark, #0052a3);
  }

  .btn-secondary {
    background: var(--color-bg, #fff);
    color: var(--color-text);
    border-color: var(--color-border, #ddd);
  }

  .btn-secondary:hover {
    background: var(--color-bg-secondary);
  }
</style>
