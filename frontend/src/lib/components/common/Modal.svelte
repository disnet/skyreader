<script lang="ts">
  import type { Snippet } from 'svelte';
  import { beforeNavigate } from '$app/navigation';

  interface Props {
    open: boolean;
    onclose: () => void;
    title?: string;
    maxWidth?: string;
    zIndex?: number;
    children: Snippet;
    header?: Snippet;
    footer?: Snippet;
  }

  let {
    open,
    onclose,
    title,
    maxWidth = '480px',
    zIndex = 100,
    children,
    header,
    footer,
  }: Props = $props();

  function handleBackdropClick(e: MouseEvent) {
    if (e.target === e.currentTarget) {
      onclose();
    }
  }

  /**
   * Come down when the app navigates.
   *
   * A modal that outlives a navigation leaves the reader on the new page with a
   * dialog still covering it, and these are rendered by the persistent shell
   * (the sidebar owns the add-feed modal), so nothing unmounts them on the way
   * out. In-app links reach modals inside shared children — LimitNotice's route
   * to /supporter, UnifyNotice's two feeds, the re-login prompt — so each one
   * would otherwise have to remember to close its host. Every modal that
   * navigates by hand already closes itself first; this is that same rule, in
   * one place, for the links it can't see.
   *
   * Watching the navigation rather than the click is what makes it reliable: a
   * click handler can't tell whether a link will actually navigate, and by the
   * time one would run SvelteKit's router has already called `preventDefault()`
   * on the event, which is indistinguishable from a child that handled its own
   * click.
   *
   * `beforeNavigate` specifically, because it fires when a navigation *starts*.
   * A redirect that was already in flight when the modal opened (the app moving
   * off `/` a moment after load) announced itself before there was anything to
   * close, so it passes by — where `afterNavigate` would land afterwards and
   * dismiss a dialog the reader had only just opened. Shallow routing (the
   * reader's `?read=` pushState) doesn't come through here at all.
   */
  beforeNavigate(({ type }) => {
    // `leave` is the tab closing; there's no page left to uncover.
    if (type !== 'leave' && open) onclose();
  });

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      onclose();
    }
  }

  // Portal to <body>. A modal opened from deep in the page (an article card, the
  // reader) would otherwise be trapped in an ancestor's stacking context, and
  // `z-index` can't climb out of one: the sticky page header (z-index 10, but in
  // a context that outranks the card's) kept painting over the backdrop while
  // everything around it dimmed. As a direct child of body the backdrop competes
  // at the root, so it covers the whole app whatever opened it.
  function portal(node: HTMLElement) {
    document.body.appendChild(node);
    return {
      destroy() {
        node.remove();
      },
    };
  }
</script>

<svelte:window onkeydown={handleKeydown} />

{#if open}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    class="modal-backdrop"
    use:portal
    onclick={handleBackdropClick}
    onkeydown={handleKeydown}
    role="dialog"
    aria-modal="true"
    tabindex="-1"
    style:--modal-max-width={maxWidth}
    style:--modal-z-index={zIndex}
  >
    <div class="modal">
      {#if header}
        {@render header()}
      {:else if title}
        <div class="modal-header">
          <h2>{title}</h2>
          <button class="close-btn" onclick={onclose} aria-label="Close"> &times; </button>
        </div>
      {/if}

      <div class="modal-body">
        {@render children()}
      </div>

      {#if footer}
        <div class="modal-footer">
          {@render footer()}
        </div>
      {/if}
    </div>
  </div>
{/if}

<style>
  .modal-backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.5);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: var(--modal-z-index, 100);
    padding: 1rem;
  }

  .modal {
    background: var(--color-bg);
    border-radius: 8px;
    width: 100%;
    max-width: var(--modal-max-width, 480px);
    max-height: 80vh;
    display: flex;
    flex-direction: column;
    box-shadow: 0 4px 20px rgba(0, 0, 0, 0.15);
  }

  .modal-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 1.5rem;
    border-bottom: 1px solid var(--color-border);
  }

  .modal-header h2 {
    font-size: var(--text-2xl);
    margin: 0;
  }

  .close-btn {
    background: none;
    border: none;
    font-size: var(--text-3xl);
    color: var(--color-text-secondary);
    padding: 0;
    line-height: var(--leading-none);
    cursor: pointer;
  }

  .close-btn:hover {
    color: var(--color-text);
  }

  .modal-body {
    padding: 1.5rem;
    overflow-y: auto;
    flex: 1;
  }

  .modal-footer {
    display: flex;
    justify-content: flex-end;
    gap: 0.75rem;
    padding: 1rem 1.5rem;
    border-top: 1px solid var(--color-border);
  }
</style>
