<script lang="ts">
  // Harness for the low-level primitives — icons, tooltips, popover menus,
  // loading/empty states, and inputs. No auth, no backend (see ../+layout.ts).
  import Icon, { type IconName } from '$lib/components/Icon.svelte';
  import Tooltip from '$lib/components/Tooltip.svelte';
  import PopoverMenu from '$lib/components/PopoverMenu.svelte';
  import LoadingState from '$lib/components/LoadingState.svelte';
  import EmptyState from '$lib/components/EmptyState.svelte';
  import DomainPatternInput from '$lib/components/DomainPatternInput.svelte';
  import PullToRefresh from '$lib/components/PullToRefresh.svelte';
  import Showcase from '../_harness/Showcase.svelte';
  import Case from '../_harness/Case.svelte';

  const ICON_NAMES: IconName[] = [
    'inbox',
    'bookmark',
    'share',
    'search',
    'bell',
    'settings',
    'message-circle',
    'users',
    'rss',
    'chevron-down',
    'chevron-up',
    'chevron-right',
    'circle',
    'circle-dot',
    'edit',
    'trash',
    'more-horizontal',
    'refresh-cw',
    'alert-circle',
    'list',
    'newspaper',
    'layers',
    'activity',
    'external-link',
    'arrow-down',
    'arrow-up',
    'plus',
    'sliders',
    'filter',
    'check',
    'file-text',
    'save',
    'type',
    'minus',
    'a-large-small',
    'share-2',
    'tag',
    'x',
    'archive',
    'arrow-left',
    'clock',
    'maximize',
    'copy',
    'highlighter',
    'send',
    'semble',
    'margin',
    'arrow-right',
    'at-sign',
    'link',
    'globe',
    'alert-triangle',
    'user',
    'folder',
    'folder-plus',
    'standard-site',
    'bluesky',
  ];

  // PopoverMenu owns its own ⋯ trigger and open state; we just feed it items.
  const menuItems = [
    { label: 'Edit', icon: 'edit', onclick: () => {} },
    { label: 'Refresh', icon: 'refresh-cw', onclick: () => {} },
    { label: 'Mark active', icon: 'check', active: true, onclick: () => {} },
    { label: 'Delete', icon: 'trash', variant: 'danger' as const, onclick: () => {} },
  ];

  // DomainPatternInput is controlled — mirror its onchange back into local state.
  let patterns = $state<string[]>(['nytimes.com', 'arstechnica.com']);
  const availableDomains = ['theverge.com', 'wired.com', 'bbc.co.uk', '404media.co'];

  function fakeRefresh() {
    return new Promise((resolve) => setTimeout(resolve, 900));
  }
</script>

<Showcase
  title="Primitives"
  description="The shared building blocks. Tooltip, PopoverMenu and the inputs are interactive — click the triggers."
>
  <Case name="Icon · full set" note="Every name Icon.svelte can render, at size 22." pad frame>
    <div class="icon-grid">
      {#each ICON_NAMES as icon (icon)}
        <div class="icon-cell" title={icon}>
          <Icon name={icon} size={22} />
          <span class="icon-label">{icon}</span>
        </div>
      {/each}
    </div>
  </Case>

  <Case name="Icon · sizes & stroke" note="size and strokeWidth props." pad frame>
    <div class="row">
      <Icon name="rss" size={14} />
      <Icon name="rss" size={18} />
      <Icon name="rss" size={24} />
      <Icon name="rss" size={32} />
      <Icon name="rss" size={32} strokeWidth={1} />
      <Icon name="rss" size={32} strokeWidth={2.5} />
    </div>
  </Case>

  <Case name="Tooltip" note="Click the ? to open a portalled tooltip." pad frame>
    <span class="row"
      >Saved articles count toward your library <Tooltip
        text="Counts every article you've saved, across all feeds and channels."
      /></span
    >
  </Case>

  <Case
    name="PopoverMenu"
    note="Self-positioning ⋯ menu with default / active / danger items."
    pad
    frame
  >
    <PopoverMenu items={menuItems} />
  </Case>

  <Case name="LoadingState · default" note="Skeleton rows (count = 4)." frame>
    <LoadingState count={4} />
  </Case>

  <Case name="LoadingState · custom message" note="message + count = 2." frame>
    <LoadingState message="Fetching your feeds…" count={2} />
  </Case>

  <Case
    name="EmptyState · with action"
    note="title + description + onAction button + icon."
    pad
    frame
  >
    <EmptyState
      title="No saved articles yet"
      description="Articles you save will collect here, ready to read offline."
      icon="📚"
      actionText="Browse feeds"
      onAction={() => {}}
    />
  </Case>

  <Case name="EmptyState · bare" note="No icon, no action — just title + description." pad frame>
    <EmptyState title="Nothing to show" description="This channel has no matching articles." />
  </Case>

  <Case
    name="DomainPatternInput"
    note="Controlled chips + suggestions; type a domain and press Enter."
    pad
    frame
  >
    <DomainPatternInput {patterns} {availableDomains} onchange={(next) => (patterns = next)} />
    <p class="echo">patterns = {JSON.stringify(patterns)}</p>
  </Case>

  <Case
    name="PullToRefresh"
    note="Touch-driven — pull down past 70px on a touch device / emulator to trigger."
    frame
    minHeight="160px"
  >
    <PullToRefresh onRefresh={fakeRefresh}>
      <div class="ptr-body">Pull me down (touch) — releases after ~0.9s.</div>
    </PullToRefresh>
  </Case>
</Showcase>

<style>
  .icon-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(96px, 1fr));
    gap: 0.75rem;
  }

  .icon-cell {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.35rem;
    padding: 0.5rem;
    border-radius: 6px;
    color: var(--color-text);
  }

  .icon-label {
    font-size: var(--text-xs);
    color: var(--color-text-secondary, #777);
    text-align: center;
  }

  .row {
    display: flex;
    align-items: center;
    gap: 1rem;
    flex-wrap: wrap;
    color: var(--color-text);
  }

  .echo {
    margin: 0.75rem 0 0;
    font-size: var(--text-xs);
    color: var(--color-text-secondary, #777);
    font-family: monospace;
  }

  .ptr-body {
    padding: 2rem 1rem;
    text-align: center;
    color: var(--color-text-secondary, #666);
  }
</style>
