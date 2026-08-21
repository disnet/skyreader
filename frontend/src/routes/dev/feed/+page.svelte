<script lang="ts">
  // Harness for presentational feed surfaces — filter popover, highlight popover,
  // the share composer drawer, and the welcome screen. No auth, no backend (see
  // ../+layout.ts).
  import FilterPopover from '$lib/components/feed/FilterPopover.svelte';
  import HighlightPopover from '$lib/components/feed/HighlightPopover.svelte';
  import ShareComposer from '$lib/components/feed/ShareComposer.svelte';
  import WelcomePage from '$lib/components/feed/WelcomePage.svelte';
  import { shareComposerStore } from '$lib/stores/shareComposer.svelte';
  import Showcase from '../_harness/Showcase.svelte';
  import Case from '../_harness/Case.svelte';

  const mockArticle = {
    subscriptionId: 0,
    guid: 'https://example.com/essay',
    url: 'https://example.com/essay',
    title: 'The Library as an Argument',
    summary:
      'A library is not a warehouse of books but an argument about what is worth keeping. ' +
      'Every collection is a claim; every catalog, a thesis.',
    publishedAt: new Date().toISOString(),
    fetchedAt: Date.now(),
  };

  let filterOpen = $state(false);

  // HighlightPopover anchors to a real DOMRect — capture it from the clicked
  // passage so the popover positions itself the way it does over real selections.
  let highlight = $state<{ mode: 'create' | 'remove'; rect: DOMRect } | null>(null);
  function openHighlight(e: MouseEvent, mode: 'create' | 'remove') {
    highlight = { mode, rect: (e.currentTarget as HTMLElement).getBoundingClientRect() };
  }
</script>

<Showcase
  title="Feed surfaces"
  description="Presentational pieces of the reading view. The popovers self-position; click the triggers to open them."
>
  <Case
    name="FilterPopover"
    note="iconName + label trigger with a children dropdown; hasFilter tints it."
    frame
    pad
    relative
  >
    <FilterPopover
      iconName="filter"
      label="Unread"
      hasFilter={true}
      open={filterOpen}
      onOpenChange={(o) => (filterOpen = o)}
      title="Filter by read state"
    >
      <div class="popover-body">
        <button class="popover-item">All</button>
        <button class="popover-item">Unread</button>
        <button class="popover-item">Read</button>
      </div>
    </FilterPopover>
  </Case>

  <Case
    name="HighlightPopover · create"
    note="Click the passage — the popover anchors to its rect."
    frame
    pad
  >
    <p class="prose">
      Select a passage to highlight it.
      <button class="passage" onclick={(e) => openHighlight(e, 'create')}
        >this sentence is the anchor</button
      >
      and the popover floats above or below it.
    </p>
  </Case>

  <Case
    name="HighlightPopover · remove"
    note="Remove mode shows the destructive variant."
    frame
    pad
  >
    <p class="prose">
      An existing
      <button class="passage marked" onclick={(e) => openHighlight(e, 'remove')}
        >highlighted passage</button
      >
      offers a Remove action.
    </p>
  </Case>

  {#if highlight}
    <HighlightPopover
      mode={highlight.mode}
      anchorRect={highlight.rect}
      onHighlight={() => (highlight = null)}
      onRemove={() => (highlight = null)}
      onClose={() => (highlight = null)}
    />
  {/if}

  <Case
    name="ShareComposer · create"
    note="The docked drawer, drafting a share. Opens over the page; minimize it to the slim bar."
    frame
    pad
  >
    <button
      class="passage"
      onclick={() => shareComposerStore.open({ article: mockArticle, mode: 'create' })}
    >
      Open the composer drawer
    </button>
  </Case>

  <Case
    name="ShareComposer · edit"
    note="Editing a posted note — quotes render as blockquotes, Post reads Update."
    frame
    pad
  >
    <button
      class="passage"
      onclick={() =>
        shareComposerStore.open({
          article: mockArticle,
          mode: 'edit',
          initialNote:
            '> Every collection is a claim; every catalog, a thesis.\n\nThe second half is the strongest argument for an owned library I’ve read.',
          submit: () => {},
        })}
    >
      Open the composer in edit mode
    </button>
  </Case>

  <ShareComposer />

  <Case name="WelcomePage" note="Static unauthenticated landing — links to /auth/login." frame>
    <WelcomePage />
  </Case>
</Showcase>

<style>
  .popover-body {
    display: flex;
    flex-direction: column;
    min-width: 160px;
  }

  .popover-item {
    text-align: left;
    padding: 0.5rem 0.75rem;
    border: none;
    background: transparent;
    color: var(--color-text, #111);
    font-size: var(--text-sm);
    cursor: pointer;
    border-radius: 6px;
  }

  .popover-item:hover {
    background: var(--color-bg-secondary, #f0f0f0);
  }

  .prose {
    margin: 0;
    line-height: 1.7;
    color: var(--color-text, #111);
  }

  .passage {
    border: none;
    background: transparent;
    padding: 0;
    font: inherit;
    color: var(--color-primary, #0066cc);
    cursor: pointer;
    text-decoration: underline;
  }

  .passage.marked {
    background: rgba(255, 214, 0, 0.35);
    color: inherit;
    text-decoration: none;
    border-radius: 2px;
  }
</style>
