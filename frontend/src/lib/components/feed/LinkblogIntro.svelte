<script lang="ts">
  // The linkblog's masthead, as an info box. The address leads, because that's the
  // thing you actually do something with (hand it to someone); the explanation
  // follows as quiet reassurance. Boxing it is what separates it from the stream:
  // it is a standing fact about the page, not the first item on it.
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

<section class="masthead">
  {#if publicUrl}
    <div class="address-row">
      <a href={publicUrl} target="_blank" rel="noopener" class="address">
        <Icon name="globe" size={15} />
        <span class="address-text">{publicLabel}</span>
        <Icon name="external-link" size={13} />
      </a>
      <button class="address-copy" onclick={copyPublicUrl} title="Copy the address of your page">
        {#if copied}
          <Icon name="check" size={14} /> Copied
        {:else}
          <Icon name="copy" size={14} /> Copy
        {/if}
      </button>
    </div>
  {/if}

  <p class="masthead-note">
    {#if pageHidden}
      Your public page is off. Everything you share still posts to your
      <strong>standard.site</strong> publication and stays readable in any Atmospheric app.
    {:else}
      Every article you share becomes a post in your own <strong>standard.site</strong> publication, stored
      in your PDS and readable in any Atmospheric app.
    {/if}
  </p>
</section>

<style>
  /* A flat info box: tinted panel, hairline, no shadow — it sits in the page, it
     doesn't float over it. Sized to hold the address at its natural weight. */
  .masthead {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    padding: 0.875rem 1rem;
    margin-bottom: 1.5rem;
    background: var(--color-bg-secondary);
    border: 1px solid var(--color-border);
    border-radius: 10px;
  }

  .address-row {
    display: flex;
    align-items: center;
    gap: 0.375rem;
    flex-wrap: wrap;
    min-width: 0;
    /* The address and the copy button carry their own padding so they can take a
       hover tint. Pulling the row back by that padding puts the address text on
       the box's own left edge, in line with the note under it. */
    margin-left: -0.5rem;
  }

  /* The address is the page's headline. Held to the Title step rather than a
     hero size: this is app chrome, and the entries below are the content. */
  .address {
    display: inline-flex;
    align-items: center;
    gap: 0.4375rem;
    min-width: 0;
    padding: 0.25rem 0.5rem;
    border-radius: 6px;
    color: var(--color-primary);
    font-size: var(--text-lg);
    font-weight: var(--weight-semibold);
    letter-spacing: var(--tracking-tight);
    text-decoration: none;
    transition: background-color 0.15s;
  }

  .address:hover {
    background: var(--color-sidebar-active);
  }

  .address:focus-visible {
    outline: 2px solid var(--color-primary);
    outline-offset: 1px;
  }

  .address-text {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  @media (max-width: 640px) {
    /* The address is the one thing on this page you hand to someone, and half an
       address is useless — so at phone width it wraps to a second line rather
       than ellipsizing away the handle that identifies it. */
    .address {
      flex-wrap: wrap;
      row-gap: 0;
    }

    .address-text {
      overflow: visible;
      white-space: normal;
      overflow-wrap: anywhere;
    }

    .address,
    .address-copy {
      min-height: 40px;
    }
  }

  .address-copy {
    display: inline-flex;
    flex-shrink: 0;
    align-items: center;
    gap: 0.3rem;
    padding: 0.25rem 0.5rem;
    background: none;
    border: none;
    border-radius: 6px;
    color: var(--color-text-secondary);
    font: inherit;
    font-size: var(--text-sm);
    font-weight: var(--weight-medium);
    cursor: pointer;
    transition:
      background-color 0.15s,
      color 0.15s;
  }

  .address-copy:hover {
    background: var(--color-sidebar-active);
    color: var(--color-text);
  }

  .address-copy:focus-visible {
    outline: 2px solid var(--color-primary);
    outline-offset: 1px;
  }

  .masthead-note {
    max-width: 60ch;
    margin: 0;
    font-size: var(--text-sm);
    line-height: var(--leading-normal);
    color: var(--color-text-secondary);
  }

  .masthead-note strong {
    color: var(--color-text);
    font-weight: var(--weight-semibold);
  }

  @media (prefers-reduced-motion: reduce) {
    .address,
    .address-copy {
      transition: none;
    }
  }
</style>
