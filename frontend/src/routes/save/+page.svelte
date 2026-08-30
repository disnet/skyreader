<script lang="ts">
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { page } from '$app/stores';
  import { auth } from '$lib/stores/auth.svelte';
  import { savesStore } from '$lib/stores/saves.svelte';
  import { ScopeUpgradeError, UrlSaveLimitError } from '$lib/services/api';
  import Logo from '$lib/assets/logo.svg';
  import LimitNotice from '$lib/components/LimitNotice.svelte';
  import { saveLimitLine } from '$lib/utils/limitCopy';
  import type { SavedItem } from '$lib/types';

  // Lightweight share-target / bookmarklet endpoint. An Apple Shortcut (or a
  // bookmarklet, or a future PWA share_target) opens
  //   https://skyreader.app/save?url=<percent-encoded article URL>
  // and this page runs the same save flow the in-app modal uses, reusing the
  // browser's existing session cookie — no token or API key needed.

  type Status = 'working' | 'success' | 'invalid' | 'limit' | 'scope' | 'error';

  let status = $state<Status>('working');
  let saved = $state<SavedItem | null>(null);
  let errorMessage = $state<string | null>(null);
  let limitInfo = $state<{ limit: number; resetsAt: string } | null>(null);

  // Pull a clean http(s) URL out of a shared string. A Shortcut/bookmarklet
  // sends a bare URL; the Web Share Target on Android often delivers it inside
  // `text`, sometimes wrapped in other words ("Great read https://…"), so fall
  // back to scanning for the first URL.
  function extractHttpUrl(raw: string): string | null {
    const s = raw.trim();
    if (!s) return null;
    try {
      const parsed = new URL(s);
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') return s;
    } catch {
      // Not a bare URL; scan the text for one below.
    }
    const match = s.match(/https?:\/\/\S+/i);
    if (match) {
      try {
        const parsed = new URL(match[0]);
        if (parsed.protocol === 'http:' || parsed.protocol === 'https:') return match[0];
      } catch {
        // Fall through.
      }
    }
    return null;
  }

  // The article URL from the query string. Accepts the `url` param (Shortcut /
  // bookmarklet) or the `text` param (PWA share_target / Android share sheet).
  function readUrl(): string | null {
    const params = $page.url.searchParams;
    for (const raw of [params.get('url'), params.get('text')]) {
      if (!raw) continue;
      const found = extractHttpUrl(raw);
      if (found) return found;
    }
    return null;
  }

  async function run() {
    const url = readUrl();
    if (!url) {
      status = 'invalid';
      return;
    }

    // Not logged in → send to login, then come back here and finish the save.
    // Re-encode the URL into the returnUrl so the path carries no literal "//"
    // (the backend's open-redirect guard rejects relative returnUrls with "//",
    // so an unencoded https:// would be silently dropped to "/").
    if (!auth.isAuthenticated) {
      const returnUrl = `/save?url=${encodeURIComponent(url)}`;
      await goto(`/auth/login?returnUrl=${encodeURIComponent(returnUrl)}`);
      return;
    }

    try {
      saved = await savesStore.saveFromUrl(url);
      status = 'success';
    } catch (err) {
      if (err instanceof ScopeUpgradeError) {
        status = 'scope';
      } else if (err instanceof UrlSaveLimitError) {
        limitInfo = { limit: err.limit, resetsAt: err.resetsAt };
        status = 'limit';
      } else {
        errorMessage = err instanceof Error ? err.message : 'Failed to save article';
        status = 'error';
      }
    }
  }

  async function openInApp() {
    if (!saved) return;
    // Mirror SaveArticleModal: navigate first, then signal which item the saved
    // view should open in the reader (pushState must run after the goto settles).
    await goto('/saved');
    savesStore.pendingOpenKey = saved.uri || saved.itemGuid || saved.rkey;
  }

  function retry() {
    status = 'working';
    errorMessage = null;
    run();
  }

  const loginReturnUrl = $derived.by(() => {
    const url = readUrl();
    return url
      ? `/auth/login?returnUrl=${encodeURIComponent(`/save?url=${encodeURIComponent(url)}`)}`
      : '/auth/login';
  });

  onMount(run);
</script>

<svelte:head>
  <title>Save to Skyreader</title>
</svelte:head>

<div class="save-page">
  <div class="card">
    <img src={Logo} alt="" class="logo" />

    {#if status === 'working'}
      <div class="spinner" aria-hidden="true"></div>
      <p class="title">Saving…</p>
      <p class="sub">{readUrl() ?? ''}</p>
    {:else if status === 'success'}
      <div class="check" aria-hidden="true">✓</div>
      <p class="title">Saved to Skyreader</p>
      {#if saved?.title}
        <p class="sub">{saved.title}</p>
      {/if}
      <button class="btn-primary" onclick={openInApp}>Open in Skyreader</button>
      <p class="hint">You can close this tab and return to your browser.</p>
    {:else if status === 'invalid'}
      <p class="title">No article to save</p>
      <p class="sub">This page needs a <code>?url=</code> link to save. Try sharing again.</p>
      <a class="btn-secondary" href="/">Go to Skyreader</a>
    {:else if status === 'limit'}
      <p class="title">Monthly save limit reached</p>
      <div class="limit-wrap">
        <LimitNotice kind="saves">
          <p>{saveLimitLine(limitInfo?.limit ?? 0, limitInfo?.resetsAt)}</p>
        </LimitNotice>
      </div>
      <a class="btn-secondary" href="/">Go to Skyreader</a>
    {:else if status === 'scope'}
      <p class="title">Log in again to save</p>
      <p class="sub">Saving needs updated permissions for your account.</p>
      <a class="btn-primary" href={loginReturnUrl}>Log in again</a>
    {:else}
      <p class="title">Couldn't save that</p>
      <p class="sub">{errorMessage}</p>
      <button class="btn-primary" onclick={retry}>Try again</button>
      <a class="btn-secondary" href="/">Go to Skyreader</a>
    {/if}
  </div>
</div>

<style>
  .limit-wrap {
    width: 100%;
    text-align: left;
  }

  .save-page {
    min-height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 1.5rem;
    background: var(--color-bg, #fff);
  }

  .card {
    width: 100%;
    max-width: 360px;
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
