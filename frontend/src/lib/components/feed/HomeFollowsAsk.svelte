<script lang="ts">
  // Home's ask for a reader who already has a library: the links people you
  // follow share on Bluesky, as one more lane, once Skyreader may read the
  // Following timeline. It sits where that lane will go, so an existing account
  // meets the feature on Home, not only in Everything or Manage Sources. "Not
  // now" hides the lane's section (Customize brings it back). A first-run Home
  // asks with HomeFollowsStart instead. See docs/plans/FOLLOWS_LINKS_PLAN.md.
  import Icon from '$lib/components/Icon.svelte';
  import { auth } from '$lib/stores/auth.svelte';
  import { grantFollowsAccess } from '$lib/utils/followsChannel';

  interface Props {
    onDismiss: () => void;
  }

  let { onDismiss }: Props = $props();
</script>

<section class="follows-ask" aria-labelledby="follows-ask-title">
  <div class="follows-ask-head">
    <Icon name="share-2" size={16} />
    <h2 id="follows-ask-title">New: links from people you follow</h2>
  </div>
  <p>
    Skyreader can gather the links people you follow share on Bluesky into a lane here, each marked
    with who shared it. It reads your Following timeline for them, keeps them for a week, and never
    posts anything.
  </p>
  <div class="follows-ask-actions">
    <button
      type="button"
      class="primary"
      disabled={auth.grantingPermissions}
      onclick={() => grantFollowsAccess('/home')}
    >
      {auth.grantingPermissions ? 'Opening Bluesky…' : 'Allow access'}
    </button>
    <button type="button" disabled={auth.grantingPermissions} onclick={onDismiss}>Not now</button>
    <span class="follows-ask-note">Bluesky asks you to confirm, then brings you back.</span>
  </div>
</section>

<style>
  /* A flat info box, like FollowsIntro in Everything: tinted panel, hairline, no
     shadow. A standing question on the page, not a card floating over it. */
  .follows-ask {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    max-width: 48rem;
    margin: 0.75rem 0.25rem 1.25rem;
    padding: 0.875rem 1rem;
    background: var(--color-bg-secondary);
    border: 1px solid var(--color-border);
    border-radius: 10px;
  }

  .follows-ask-head {
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

  .follows-ask-actions {
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

  .follows-ask-note {
    font-size: var(--text-xs);
    color: var(--color-text-secondary);
  }
</style>
