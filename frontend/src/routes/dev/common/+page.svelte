<script lang="ts">
  // Harness for the common container shells — Modal, BottomSheet, the StateView
  // load/empty/content switch, the infinite-scroll sentinel, and UserCard. No
  // auth, no backend (see ../+layout.ts).
  import Modal from '$lib/components/common/Modal.svelte';
  import BottomSheet from '$lib/components/common/BottomSheet.svelte';
  import StateView from '$lib/components/common/StateView.svelte';
  import InfiniteScrollSentinel from '$lib/components/common/InfiniteScrollSentinel.svelte';
  import UserCard from '$lib/components/common/UserCard.svelte';
  import Showcase from '../_harness/Showcase.svelte';
  import Case from '../_harness/Case.svelte';

  let modalOpen = $state(false);
  let sheetOpen = $state(false);

  // StateView toggles between its three branches.
  let stateMode = $state<'loading' | 'empty' | 'content'>('content');

  const AVATAR = 'https://icons.duckduckgo.com/ip3/bsky.app.ico';
</script>

<Showcase
  title="Common shells"
  description="Reusable containers and state wrappers. Open the overlays with the buttons; flip StateView between its branches."
>
  <Case name="Modal" note="open / onclose + title + children + footer snippet." pad frame>
    <button class="btn" onclick={() => (modalOpen = true)}>Open modal</button>
    <Modal open={modalOpen} onclose={() => (modalOpen = false)} title="Edit feed">
      <p>Modal body content goes here. Escape, backdrop click, or the × all close it.</p>
      {#snippet footer()}
        <button class="btn ghost" onclick={() => (modalOpen = false)}>Cancel</button>
        <button class="btn" onclick={() => (modalOpen = false)}>Save</button>
      {/snippet}
    </Modal>
  </Case>

  <Case
    name="BottomSheet"
    note="open / onclose + title; drag down or tap backdrop to dismiss."
    pad
    frame
  >
    <button class="btn" onclick={() => (sheetOpen = true)}>Open bottom sheet</button>
    <BottomSheet open={sheetOpen} onclose={() => (sheetOpen = false)} title="Filters">
      <p>Mobile-style sheet content. Drag the handle down past 100px to dismiss.</p>
    </BottomSheet>
  </Case>

  <Case name="StateView" note="isLoading / isEmpty / content — flip below." pad frame>
    <div class="row" style="margin-bottom: 1rem;">
      <button
        class="btn ghost"
        class:on={stateMode === 'loading'}
        onclick={() => (stateMode = 'loading')}>loading</button
      >
      <button
        class="btn ghost"
        class:on={stateMode === 'empty'}
        onclick={() => (stateMode = 'empty')}>empty</button
      >
      <button
        class="btn ghost"
        class:on={stateMode === 'content'}
        onclick={() => (stateMode = 'content')}>content</button
      >
    </div>
    <StateView
      isLoading={stateMode === 'loading'}
      isEmpty={stateMode === 'empty'}
      loadingMessage="Loading channel…"
      emptyTitle="Empty channel"
      emptyDescription="No articles match this channel's filters yet."
      emptyIcon="🗂️"
    >
      <p>Loaded content renders here when not loading and not empty.</p>
    </StateView>
  </Case>

  <Case
    name="InfiniteScrollSentinel · loading more"
    note="hasMore + isLoading shows the spinner row."
    frame
    pad
  >
    <InfiniteScrollSentinel hasMore={true} isLoading={true} onLoadMore={() => {}} />
  </Case>

  <Case
    name="InfiniteScrollSentinel · idle"
    note="hasMore but not loading — invisible sentinel (nothing visible is correct)."
    frame
    pad
  >
    <InfiniteScrollSentinel hasMore={true} isLoading={false} onLoadMore={() => {}} />
  </Case>

  <Case name="UserCard · sizes (inline)" note="size = small / medium / large." pad frame>
    <div class="stack">
      <UserCard
        avatarUrl={AVATAR}
        displayName="Alice Reads"
        handle="alice.bsky.social"
        size="small"
      />
      <UserCard
        avatarUrl={AVATAR}
        displayName="Alice Reads"
        handle="alice.bsky.social"
        size="medium"
      />
      <UserCard
        avatarUrl={AVATAR}
        displayName="Alice Reads"
        handle="alice.bsky.social"
        size="large"
      />
    </div>
  </Case>

  <Case
    name="UserCard · card variant + snippets"
    note="variant='card' with badge and actions snippets; dimmed; no-avatar placeholder."
    pad
    frame
  >
    <div class="stack">
      <UserCard
        avatarUrl={AVATAR}
        displayName="Bob Builder"
        handle="bob.example.com"
        variant="card"
      >
        {#snippet badge()}<span class="badge">follows you</span>{/snippet}
        {#snippet actions()}<button class="btn ghost">Follow</button>{/snippet}
      </UserCard>
      <UserCard displayName="Carol No-Avatar" handle="carol.test" variant="card" dimmed />
    </div>
  </Case>
</Showcase>

<style>
  .btn {
    display: inline-flex;
    align-items: center;
    padding: 0.4rem 0.85rem;
    border: 1px solid var(--color-primary, #0066cc);
    border-radius: 6px;
    background: var(--color-primary, #0066cc);
    color: #fff;
    font-size: var(--text-sm);
    cursor: pointer;
  }

  .btn.ghost {
    background: transparent;
    color: var(--color-text, #111);
    border-color: var(--color-border, #ddd);
  }

  .btn.ghost.on {
    border-color: var(--color-primary, #0066cc);
    color: var(--color-primary, #0066cc);
  }

  .row {
    display: flex;
    gap: 0.5rem;
    flex-wrap: wrap;
  }

  .stack {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    align-items: flex-start;
  }

  .badge {
    font-size: var(--text-xs);
    color: var(--color-text-secondary, #666);
    background: var(--color-bg-secondary, #f0f0f0);
    border-radius: 999px;
    padding: 0.1rem 0.5rem;
  }
</style>
