<script lang="ts">
  // What guest mode is, said once, at the top of Home.
  //
  // A guest arrives from "Start Reading" with no onboarding and a library they
  // did not choose, so the two things worth saying are what is already theirs
  // (everything local, and it survives signing in) and what an account adds.
  // Dismissible, because a permanent banner over the reading surface is exactly
  // the chrome this app refuses.
  import Icon from '$lib/components/Icon.svelte';
  import { auth } from '$lib/stores/auth.svelte';

  const DISMISS_KEY = 'skyreader-guest-banner-dismissed';

  // A guest has no account to hang a preference on, so this is local by nature.
  // Reading it can throw outright in a locked-down private window, which is
  // also the one place a guest is most likely to be reading.
  function readDismissed(): boolean {
    try {
      return localStorage.getItem(DISMISS_KEY) === '1';
    } catch {
      return false;
    }
  }

  let dismissed = $state(readDismissed());

  function dismiss() {
    dismissed = true;
    try {
      localStorage.setItem(DISMISS_KEY, '1');
    } catch {
      // Fine: it stays dismissed for this session and returns next time.
    }
  }
</script>

{#if auth.isGuest && !dismissed}
  <aside class="guest-banner">
    <button class="dismiss" onclick={dismiss} title="Dismiss" aria-label="Dismiss">
      <Icon name="x" size={14} />
    </button>

    <h2>Reading as a guest</h2>
    <p>
      Everything you save stays on this device. Read, highlight, and build a daily magazine without
      an account.
    </p>
    <p>
      An account adds your own feeds, sync across devices, your linkblog, and saving out to Semble
      or Margin.
    </p>

    <div class="actions">
      <a class="signin" href="/auth/login?returnUrl=/home">Sign in</a>
      <span class="promise">What you have saved and highlighted here comes with you.</span>
    </div>
  </aside>
{/if}

<style>
  /* Flat by default (DESIGN.md): a bordered block on the page, never floating,
     so it earns no shadow. Same notice idiom as LimitNotice. */
  .guest-banner {
    position: relative;
    margin-bottom: 1.25rem;
    padding: 0.875rem 1rem;
    border: 1px solid var(--color-border);
    border-radius: 6px;
    background: var(--color-bg-secondary);
    color: var(--color-text);
  }

  .guest-banner h2 {
    margin: 0 0 0.375rem;
    /* Sits under the greeting, so it must not compete with it. */
    font-size: var(--text-md);
    font-weight: var(--weight-semibold);
    line-height: var(--leading-snug);
  }

  .guest-banner p {
    margin: 0 0 0.375rem;
    /* No measure cap: each line is one short statement, and holding it to a
       reading measure broke both across two lines for no gain. Only the
       dismiss control needs to be kept clear. */
    padding-right: 1.5rem;
    font-size: var(--text-md);
    line-height: 1.5;
    color: var(--color-text-secondary);
  }

  .actions {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 0.4rem 0.75rem;
    margin-top: 0.625rem;
  }

  /* One Blue (DESIGN.md). */
  .signin {
    font-size: var(--text-md);
    font-weight: var(--weight-medium);
    color: var(--color-primary);
    text-decoration: none;
  }

  .signin:hover {
    text-decoration: underline;
  }

  /* The reason the button is safe to press, next to the button. */
  .promise {
    font-size: var(--text-sm);
    color: var(--color-text-secondary);
  }

  .dismiss {
    position: absolute;
    top: 0.5rem;
    right: 0.5rem;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 0.25rem;
    border: none;
    background: none;
    border-radius: 4px;
    color: var(--color-text-secondary);
    cursor: pointer;
  }

  /* The banner already sits on Sunken, so the hover fill has to be the next
     step in, not another wash of the same tone. */
  .dismiss:hover {
    background: var(--color-border);
    color: var(--color-text);
  }
</style>
