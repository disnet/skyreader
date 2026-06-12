<script lang="ts">
  // Harness for sidebar chrome — collapsible nav sections, view/channel rows, the
  // right-click context menu, and the drag-to-resize handle. No auth, no backend
  // (see ../+layout.ts).
  import NavSection from '$lib/components/sidebar/NavSection.svelte';
  import ViewItem from '$lib/components/sidebar/ViewItem.svelte';
  import ContextMenu from '$lib/components/sidebar/ContextMenu.svelte';
  import ResizeHandle from '$lib/components/sidebar/ResizeHandle.svelte';
  import type { FilteredView } from '$lib/types';
  import Showcase from '../_harness/Showcase.svelte';
  import Case from '../_harness/Case.svelte';

  let sectionExpanded = $state(true);
  let onlyUnread = $state(false);

  let renaming = $state(false);
  const view = {
    uuid: 'view-1',
    name: 'Morning read',
    mode: 'feed',
    readFilter: 'all',
    sortOrder: 'newest',
    createdAt: 0,
    updatedAt: 0,
    position: 0,
  } satisfies FilteredView;

  const savedView = {
    uuid: 'view-2',
    name: 'Saved to read',
    mode: 'saved',
    readFilter: 'all',
    sortOrder: 'newest',
    createdAt: 0,
    updatedAt: 0,
    position: 1,
  } satisfies FilteredView;

  let menuPos = $state<{ x: number; y: number } | null>(null);

  let sidebarWidth = $state(260);
</script>

<Showcase
  title="Sidebar"
  description="Sidebar building blocks. The context menu and resize handle are position-anchored — the menu floats at fixed viewport coords; the resize handle is hidden below 1000px viewport width."
>
  <Case
    name="NavSection · expanded"
    note="isExpanded + active, with the unread-filter and + buttons."
    frame
    pad
  >
    <div class="sidebar-frame">
      <NavSection
        title="Feeds"
        icon="newspaper"
        isExpanded={sectionExpanded}
        showOnlyUnread={onlyUnread}
        isActive={true}
        onAdd={() => {}}
        onToggle={() => (sectionExpanded = !sectionExpanded)}
        onLabelClick={() => {}}
        onUnreadToggle={() => (onlyUnread = !onlyUnread)}
      >
        <div class="nav-child">All articles</div>
        <div class="nav-child">Tech</div>
        <div class="nav-child">News</div>
      </NavSection>
    </div>
  </Case>

  <Case
    name="ViewItem"
    note="Channel row — feed vs saved icon, active state, unread badge. Click ⋯ / use the rename toggle."
    frame
    pad
  >
    <div class="sidebar-frame">
      <ViewItem
        {view}
        isActive={true}
        isRenaming={renaming}
        unreadCount={7}
        onSelect={() => {}}
        onContextMenu={() => {}}
        onTouchStart={() => {}}
        onTouchEnd={() => {}}
        onTouchMove={() => {}}
        onMoreClick={() => (renaming = true)}
        onRename={() => (renaming = false)}
        onRenameCancel={() => (renaming = false)}
      />
      <ViewItem
        view={savedView}
        isActive={false}
        isRenaming={false}
        unreadCount={0}
        onSelect={() => {}}
        onContextMenu={() => {}}
        onTouchStart={() => {}}
        onTouchEnd={() => {}}
        onTouchMove={() => {}}
        onMoreClick={() => {}}
        onRename={() => {}}
        onRenameCancel={() => {}}
      />
    </div>
  </Case>

  <Case
    name="ContextMenu"
    note="position:fixed — opens at viewport coords. Edit/Rename are optional buttons; Delete is danger."
    frame
    pad
  >
    <button class="btn ghost" onclick={(e) => (menuPos = { x: e.clientX, y: e.clientY })}>
      Open context menu here
    </button>
    {#if menuPos}
      <ContextMenu
        x={menuPos.x}
        y={menuPos.y}
        onEdit={() => (menuPos = null)}
        onRename={() => (menuPos = null)}
        onDelete={() => (menuPos = null)}
        onClose={() => (menuPos = null)}
        deleteLabel="Delete channel"
      />
    {/if}
  </Case>

  <Case
    name="ResizeHandle"
    note="Drag the right edge of the faux sidebar (≥1000px viewport). Clamped 180–400px."
    frame
  >
    <div class="resizable" style:width="{sidebarWidth}px">
      <div class="resizable-label">Sidebar — {sidebarWidth}px</div>
      <ResizeHandle
        width={sidebarWidth}
        onWidthChange={(w) => (sidebarWidth = w)}
        minWidth={180}
        maxWidth={400}
      />
    </div>
  </Case>
</Showcase>

<style>
  .sidebar-frame {
    width: 260px;
    max-width: 100%;
    background: var(--color-bg-secondary, #f7f7f7);
    border-radius: 8px;
    padding: 0.5rem;
  }

  .nav-child {
    padding: 0.35rem 0.75rem;
    font-size: var(--text-sm);
    color: var(--color-text-secondary, #555);
  }

  .resizable {
    position: relative;
    min-height: 120px;
    background: var(--color-bg-secondary, #f7f7f7);
    border-radius: 8px;
    padding: 1rem;
  }

  .resizable-label {
    font-size: var(--text-sm);
    color: var(--color-text-secondary, #555);
  }

  .btn.ghost {
    display: inline-flex;
    align-items: center;
    padding: 0.4rem 0.85rem;
    border: 1px solid var(--color-border, #ddd);
    border-radius: 6px;
    background: transparent;
    color: var(--color-text, #111);
    font-size: var(--text-sm);
    cursor: pointer;
  }
</style>
