<script lang="ts">
  import type { Snippet } from 'svelte';
  import { beforeNavigate } from '$app/navigation';
  import Icon, { type IconName } from '$lib/components/Icon.svelte';

  interface Props {
    open: boolean;
    onclose: () => void;
    title?: string;
    /** A mark beside the title, in a small tile: what kind of thing this dialog is about. */
    icon?: IconName;
    /** `danger` tints the icon tile for a dialog that destroys something. */
    tone?: 'default' | 'danger';
    /** One muted line under the title, when the title can't say it alone. */
    description?: string;
    maxWidth?: string;
    zIndex?: number;
    /** Override the body's padding (a compact header may want the body tucked up). */
    bodyPadding?: string;
    children: Snippet;
    /** Replaces the whole header (the title row, close button and all). */
    header?: Snippet;
    /** Rides under the standard title row, edge to edge (tabs, say). */
    headerExtra?: Snippet;
    footer?: Snippet;
  }

  let {
    open,
    onclose,
    title,
    icon,
    tone = 'default',
    description,
    maxWidth = '480px',
    zIndex = 100,
    bodyPadding,
    children,
    header,
    headerExtra,
    footer,
  }: Props = $props();

  const titleId = $props.id();

  // The header sits flush on the body with no rule under it; the rule comes in
  // once content scrolls beneath, which is the only time it separates anything.
  let scrolled = $state(false);
  // The component outlives each open, so a rule earned by scrolling must not
  // carry over to the next time the dialog opens at the top.
  $effect(() => {
    if (!open) scrolled = false;
  });

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
    aria-labelledby={title && !header ? titleId : undefined}
    tabindex="-1"
    style:--modal-max-width={maxWidth}
    style:--modal-z-index={zIndex}
    style:--modal-body-padding={bodyPadding}
  >
    <div class="modal" class:roomy-top={header || headerExtra || !title}>
      {#if header}
        {@render header()}
      {:else if title}
        <div class="modal-header" class:ruled={scrolled || headerExtra}>
          <div class="modal-title-row">
            {#if icon}
              <span class="modal-mark" class:danger={tone === 'danger'} aria-hidden="true">
                <Icon name={icon} size={17} />
              </span>
            {/if}
            <div class="modal-heading">
              <h2 id={titleId}>{title}</h2>
              {#if description}<p class="modal-description">{description}</p>{/if}
            </div>
            <button type="button" class="close-btn" onclick={onclose} aria-label="Close">
              <Icon name="x" size={18} />
            </button>
          </div>
          {#if headerExtra}
            {@render headerExtra()}
          {/if}
        </div>
      {/if}

      <div class="modal-body" onscroll={(e) => (scrolled = e.currentTarget.scrollTop > 0)}>
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
  /* --modal-inset is the one horizontal measure: header, body and footer all
     line up on it, and content that wants to run edge to edge (the channel
     editor's pinned Save row) can borrow it. Declared on the backdrop so a
     consumer's bodyPadding can say var(--modal-inset) too. */
  .modal-backdrop {
    --modal-inset: 1.25rem;
    --modal-footer-bg: var(--color-bg-secondary);
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.4);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: var(--modal-z-index, 100);
    padding: 1rem;
    animation: modal-fade 160ms ease-out;
  }

  .modal {
    background: var(--color-bg);
    border-radius: 12px;
    width: 100%;
    max-width: var(--modal-max-width, 480px);
    max-height: 80vh;
    max-height: 80dvh;
    display: flex;
    flex-direction: column;
    /* Clips the footer band and anything pinned to the bottom of the body to
       the rounded corners. */
    overflow: hidden;
    box-shadow:
      0 12px 32px rgba(0, 0, 0, 0.16),
      0 2px 6px rgba(0, 0, 0, 0.08);
    animation: modal-rise 240ms cubic-bezier(0.16, 1, 0.3, 1);
  }

  @keyframes modal-fade {
    from {
      opacity: 0;
    }
  }

  @keyframes modal-rise {
    from {
      opacity: 0;
      transform: translateY(8px) scale(0.985);
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .modal {
      animation-name: modal-fade;
    }
  }

  .modal-header {
    flex-shrink: 0;
    border-bottom: 1px solid transparent;
    transition: border-color 0.15s;
  }

  .modal-header.ruled {
    border-bottom-color: var(--color-border);
  }

  .modal-title-row {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    padding: 0.875rem 0.75rem 0.625rem var(--modal-inset);
  }

  .modal-mark {
    flex-shrink: 0;
    display: grid;
    place-items: center;
    width: 2rem;
    height: 2rem;
    border-radius: 8px;
    background: var(--color-bg-secondary);
    color: var(--color-text);
  }

  .modal-mark.danger {
    background: rgba(244, 67, 54, 0.1);
    color: var(--color-error);
  }

  .modal-heading {
    flex: 1;
    min-width: 0;
  }

  .modal-heading h2 {
    margin: 0;
    font-size: var(--text-xl);
    font-weight: var(--weight-semibold);
    line-height: var(--leading-tight);
    letter-spacing: var(--tracking-tight);
    text-wrap: balance;
  }

  .modal-description {
    margin: 0.125rem 0 0;
    font-size: var(--text-sm);
    line-height: var(--leading-snug);
    color: var(--color-text-secondary);
  }

  .close-btn {
    flex-shrink: 0;
    align-self: flex-start;
    display: grid;
    place-items: center;
    width: 2rem;
    height: 2rem;
    padding: 0;
    border: none;
    border-radius: 6px;
    background: none;
    color: var(--color-text-secondary);
    cursor: pointer;
    transition:
      background-color 0.15s,
      color 0.15s;
  }

  .close-btn:hover {
    background: var(--color-bg-secondary);
    color: var(--color-text);
  }

  .close-btn:focus-visible {
    outline: 2px solid var(--color-primary);
    outline-offset: -2px;
  }

  .modal-body {
    padding: var(--modal-body-padding, var(--modal-body-top, 0.25rem) var(--modal-inset) 1.25rem);
    overflow-y: auto;
    flex: 1;
  }

  /* The body tucks up under a plain title row; under anything else (a
     consumer's own header, tabs, or no header at all) it takes the full inset. */
  .modal.roomy-top {
    --modal-body-top: var(--modal-inset);
  }

  /* A tinted band: the actions read as the dialog's base, not one more row of
     content. Buttons inherit Label size from here. */
  .modal-footer {
    flex-shrink: 0;
    display: flex;
    justify-content: flex-end;
    align-items: center;
    gap: 0.5rem;
    padding: 0.75rem var(--modal-inset);
    border-top: 1px solid var(--color-border);
    background: var(--modal-footer-bg);
    font-size: var(--text-md);
  }

  @media (prefers-color-scheme: dark) {
    .modal-backdrop {
      background: rgba(0, 0, 0, 0.6);
    }

    .modal {
      /* A shadow barely reads on a dark page; a hairline edge does. */
      box-shadow:
        0 0 0 1px var(--color-border),
        0 12px 32px rgba(0, 0, 0, 0.4);
    }

    .modal-mark.danger {
      background: rgba(244, 67, 54, 0.15);
    }
  }

  /* A phone has no room to spare: give the dialog the height and keep the
     chrome compact, so the content (and its buttons) stay in view. */
  @media (max-width: 640px) {
    .modal-backdrop {
      --modal-inset: 1rem;
      padding: 0.75rem;
    }

    .modal {
      max-height: 100%;
    }

    .modal-title-row {
      gap: 0.625rem;
      padding: 0.625rem 0.5rem 0.5rem var(--modal-inset);
    }

    .modal-heading h2 {
      font-size: var(--text-lg);
    }

    .modal-mark {
      width: 1.75rem;
      height: 1.75rem;
    }
  }
</style>
