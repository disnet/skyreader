<script lang="ts">
  import Icon from '$lib/components/Icon.svelte';
  import { myLinkblogStore } from '$lib/stores/myLinkblog.svelte';

  // The Skyreader page can be turned off while links keep going to a connected
  // publication. The publication's `url` still describes where that page would
  // be, so it stays populated — but the page itself 404s, and there's nothing
  // to hand anyone.
  let pageHidden = $derived(myLinkblogStore.publication?.pageHidden === true);
  let publicUrl = $derived(pageHidden ? null : myLinkblogStore.publicUrl());
  let publicLabel = $derived(
    publicUrl ? publicUrl.replace(/^https?:\/\//, '').replace(/\/$/, '') : ''
  );

  let copied = $state(false);
  async function copyPublicUrl() {
    if (!publicUrl) return;
    try {
      await navigator.clipboard.writeText(publicUrl);
      copied = true;
      setTimeout(() => (copied = false), 1500);
    } catch {
      // Clipboard can be unavailable (insecure context); the visible link is the fallback.
    }
  }
</script>

<section class="linkblog-intro">
  <p class="intro-desc">
    Every article you share becomes a post in your own <strong>standard.site</strong> publication —
    stored in your PDS, and portable across the Atmosphere. Read it in any Atmospheric app{#if !pageHidden},
      or share the page below{/if}.
  </p>

  {#if publicUrl}
    <div class="public-link">
      <a href={publicUrl} target="_blank" rel="noopener" class="public-url">
        <Icon name="globe" size={15} />
        <span class="public-url-text">{publicLabel}</span>
        <Icon name="external-link" size={13} />
      </a>
      <button class="copy-btn" onclick={copyPublicUrl} title="Copy link">
        {#if copied}
          <Icon name="check" size={14} /> Copied
        {:else}
          <Icon name="copy" size={14} /> Copy
        {/if}
      </button>
    </div>
  {/if}
</section>

<style>
  .linkblog-intro {
    padding: 0 0 1.25rem;
    margin-bottom: 0.5rem;
    border-bottom: 1px solid var(--color-border);
  }

  .intro-desc {
    font-size: var(--text-md);
    color: var(--color-text-secondary);
    line-height: 1.55;
    margin: 0;
    max-width: 60ch;
  }

  .intro-desc strong {
    color: var(--color-text);
    font-weight: var(--weight-semibold);
  }

  .public-link {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin-top: 0.875rem;
    flex-wrap: wrap;
  }

  .public-url {
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
    font-size: var(--text-sm);
    color: var(--color-primary);
    text-decoration: none;
    padding: 0.375rem 0.625rem;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md, 6px);
    min-width: 0;
  }

  .public-url:hover {
    background: var(--color-bg-secondary, rgba(0, 0, 0, 0.03));
  }

  .public-url-text {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .copy-btn {
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
    font: inherit;
    font-size: var(--text-sm);
    color: var(--color-text-secondary);
    background: none;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md, 6px);
    padding: 0.375rem 0.625rem;
    cursor: pointer;
  }

  .copy-btn:hover {
    background: var(--color-bg-secondary, rgba(0, 0, 0, 0.03));
  }
</style>
