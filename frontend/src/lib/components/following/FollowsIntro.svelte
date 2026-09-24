<script lang="ts">
  // Everything's one-time question: add the links people you follow share on
  // Bluesky to it, or not. Shown at the top of Everything until answered; the
  // answer is saved for the account (so it's asked once, not once per device)
  // and can be changed on Manage Sources. Boxed like LinkblogIntro: a standing
  // question about the page, not the first item on it.
  // See docs/plans/FOLLOWS_LINKS_PLAN.md.
  import Icon from '$lib/components/Icon.svelte';
  import { followLinksStore } from '$lib/stores/followLinks.svelte';
  import { toastStore } from '$lib/stores/toast.svelte';
  import { FEEDS_PATH } from '$lib/utils/viewNav';
  import { grantFollowsAccess } from '$lib/utils/followsChannel';

  let busy = $state(false);

  async function answer(on: boolean) {
    if (busy) return;
    busy = true;
    try {
      // Saved before the permission a "yes" may need, so it's on when they're back.
      await followLinksStore.setInEverything(on);
      if (on && followLinksStore.scopeRequired) await grantFollowsAccess(FEEDS_PATH);
    } catch {
      const id = toastStore.add('');
      toastStore.update(id, 'error', "Couldn't save that. Try again in a moment.");
    }
    busy = false;
  }
</script>

<section class="follows-intro" aria-labelledby="follows-intro-title">
  <div class="follows-intro-head">
    <Icon name="share-2" size={16} />
    <h2 id="follows-intro-title">Links from people you follow</h2>
  </div>
  <p>
    Skyreader can add the links people you follow share on Bluesky to Everything, each marked with
    who shared it. It reads your Following timeline for them, keeps them for a week, and never posts
    anything.
    {#if followLinksStore.scopeRequired}Turning it on asks your permission, once.{/if}
  </p>
  <div class="follows-intro-actions">
    <button type="button" class="primary" disabled={busy} onclick={() => answer(true)}>
      Add them to Everything
    </button>
    <button type="button" disabled={busy} onclick={() => answer(false)}>Not now</button>
    <span class="follows-intro-note">You can change this in Manage Sources.</span>
  </div>
</section>

<style>
  /* A flat info box, like the linkblog's masthead: tinted panel, hairline, no
     shadow. It sits in the page, it doesn't float over it. */
  .follows-intro {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    padding: 0.875rem 1rem;
    margin-bottom: 1rem;
    background: var(--color-bg-secondary);
    border: 1px solid var(--color-border);
    border-radius: 10px;
  }

  .follows-intro-head {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    color: var(--color-text-secondary);
  }

  h2 {
    margin: 0;
    font-size: var(--text-md);
    font-weight: var(--weight-semibold);
    color: var(--color-text);
  }

  p {
    margin: 0;
    max-width: 62ch;
    font-size: var(--text-sm);
    line-height: var(--leading-normal);
    color: var(--color-text-secondary);
  }

  .follows-intro-actions {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.5rem 0.75rem;
    margin-top: 0.25rem;
  }

  button {
    padding: 0.375rem 0.875rem;
    font: inherit;
    font-size: var(--text-sm);
    font-weight: var(--weight-medium);
    color: var(--color-text);
    background: var(--color-bg);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md, 6px);
    cursor: pointer;
  }

  button:hover:not(:disabled) {
    border-color: var(--color-primary);
  }

  button.primary {
    color: #fff;
    background: var(--color-primary);
    border-color: var(--color-primary);
  }

  button.primary:hover:not(:disabled) {
    background: var(--color-primary-dark);
  }

  button:disabled {
    opacity: 0.6;
    cursor: default;
  }

  button:focus-visible {
    outline: 2px solid var(--color-primary);
    outline-offset: 2px;
  }

  .follows-intro-note {
    font-size: var(--text-xs);
    color: var(--color-text-secondary);
  }
</style>
