<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { followAnchor, positionFloating } from '$lib/utils/floating';
  import type { CommunityHighlightGroup } from '$lib/stores/communityHighlights.svelte';

  let {
    group,
    anchorRect,
    getAnchorRect,
    itemUrl,
    capped = false,
    onClose,
  }: {
    group: CommunityHighlightGroup;
    anchorRect: DOMRect;
    /**
     * Live position of the highlight this popover belongs to. Supplied so the
     * popover tracks the passage as the reader scrolls instead of hanging at the
     * viewport spot it opened in; it closes once the passage scrolls away.
     */
    getAnchorRect?: () => DOMRect | null;
    itemUrl: string;
    capped?: boolean;
    onClose: () => void;
  } = $props();
  let marginUrl = $derived(`https://margin.at/url/${encodeURIComponent(itemUrl)}`);
  let el: HTMLDivElement;
  function outside(event: Event) {
    if (!el?.contains(event.target as Node)) onClose();
  }
  function keydown(event: KeyboardEvent) {
    if (event.key === 'Escape') onClose();
  }
  let stopFollowing: (() => void) | undefined;
  onMount(() => {
    document.addEventListener('mousedown', outside, true);
    document.addEventListener('touchstart', outside, true);
    document.addEventListener('keydown', keydown, true);
    requestAnimationFrame(() => positionFloating(anchorRect, el, { gap: 6, align: 'center' }));
    if (getAnchorRect)
      stopFollowing = followAnchor(() => el, getAnchorRect, {
        gap: 6,
        align: 'center',
        onLost: onClose,
      });
  });
  onDestroy(() => {
    stopFollowing?.();
    document.removeEventListener('mousedown', outside, true);
    document.removeEventListener('touchstart', outside, true);
    document.removeEventListener('keydown', keydown, true);
  });
</script>

<!-- svelte-ignore a11y_no_static_element_interactions a11y_click_events_have_key_events -->
<div
  class="community-popover"
  bind:this={el}
  role="dialog"
  tabindex="-1"
  aria-label="Community highlight"
  onclick={(e) => e.stopPropagation()}
>
  {#each group.people as person}
    <div class="person">
      {#if person.avatar}<img src={person.avatar} alt="" />{/if}
      <div>
        <strong>{person.displayName || person.handle || 'A reader'}</strong>
        <span class="meta">
          {person.motivation === 'commenting' ? ' commented' : ' highlighted'}{person.createdAt
            ? ` · ${new Date(person.createdAt).toLocaleDateString()}`
            : ''}
        </span>
        {#if person.note}<p>{person.note}</p>{/if}
      </div>
    </div>
  {/each}
  <a
    class="source"
    href={marginUrl}
    target="_blank"
    rel="noopener noreferrer"
    aria-label="View highlights for this article on margin.at">View on margin.at ↗</a
  >
  {#if capped}<div class="source-note">More highlights may be available.</div>{/if}
</div>

<style>
  .community-popover {
    position: fixed;
    z-index: 210;
    width: min(19rem, calc(100vw - 2rem));
    max-height: min(22rem, 60vh);
    overflow: auto;
    padding: 0.75rem;
    border: 1px solid var(--border-color, #d7d7d7);
    border-radius: 0.5rem;
    background: var(--surface-color, #fff);
    color: var(--text-color, #222);
    box-shadow: 0 8px 24px rgb(0 0 0 / 0.14);
  }
  .person {
    display: flex;
    gap: 0.55rem;
  }
  .person + .person {
    margin-top: 0.7rem;
    padding-top: 0.7rem;
    border-top: 1px solid var(--border-color, #e5e5e5);
  }
  img {
    width: 1.75rem;
    height: 1.75rem;
    border-radius: 50%;
    object-fit: cover;
  }
  strong {
    font-size: 0.85rem;
    font-weight: 600;
  }
  .meta {
    color: var(--text-muted, #717171);
    font-size: 0.72rem;
  }
  p {
    margin: 0.2rem 0 0;
    font-size: 0.85rem;
    line-height: 1.4;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  .source {
    display: inline-block;
    margin-top: 0.65rem;
    color: var(--color-primary, #0066cc);
    font-size: 0.75rem;
    text-decoration: none;
  }
  .source:hover {
    text-decoration: underline;
  }
  .source-note {
    margin-top: 0.35rem;
    color: var(--text-muted, #717171);
    font-size: 0.75rem;
  }
</style>
