<script lang="ts">
  // Harness for the sources (feed-management) surface — toolbar, section + group
  // headers, source rows across states, and the bulk-action bar. No auth, no
  // backend (see ../+layout.ts).
  import SourcesToolbar from '$lib/components/sources/SourcesToolbar.svelte';
  import SourceSectionHeader from '$lib/components/sources/SourceSectionHeader.svelte';
  import SourceGroupHeader from '$lib/components/sources/SourceGroupHeader.svelte';
  import SourceRow from '$lib/components/sources/SourceRow.svelte';
  import BulkActionBar from '$lib/components/sources/BulkActionBar.svelte';
  import Showcase from '../_harness/Showcase.svelte';
  import Case from '../_harness/Case.svelte';

  let search = $state('');
  let sectionCollapsed = $state(false);
  let rowSelected = $state(false);
  let showBulkBar = $state(false);

  const FAVICON = 'https://icons.duckduckgo.com/ip3/arstechnica.com.ico';
  const AVATAR = 'https://icons.duckduckgo.com/ip3/bsky.app.ico';
</script>

<Showcase
  title="Sources"
  description="The feed-management surface. Rows show their hover actions on pointer-over; the bulk bar floats at the bottom of the viewport when toggled on."
>
  <Case name="SourcesToolbar" note="Controlled search + an Add-source dropdown." pad frame>
    <SourcesToolbar
      searchQuery={search}
      onSearchChange={(v) => (search = v)}
      onAddRss={() => {}}
      onAddHandle={() => {}}
    />
    <p class="echo">searchQuery = {JSON.stringify(search)}</p>
  </Case>

  <Case name="SourceSectionHeader" note="Collapsible — click to toggle the chevron." pad frame>
    <SourceSectionHeader
      icon="rss"
      title="RSS feeds"
      subtitle="Standard web feeds"
      count={12}
      collapsed={sectionCollapsed}
      onToggle={() => (sectionCollapsed = !sectionCollapsed)}
    />
  </Case>

  <Case name="SourceGroupHeader" note="Account group header with avatar + remove-all." pad frame>
    <SourceGroupHeader
      avatarUrl={AVATAR}
      displayName="Ars Technica"
      handle="arstechnica.com"
      onRemoveAll={() => {}}
    />
  </Case>

  <Case name="SourceRow · default" note="Subscribed, no error; hover to reveal actions." frame>
    <SourceRow
      iconUrl={FAVICON}
      title="Ars Technica"
      subtitle="arstechnica.com · 8 unread"
      selected={rowSelected}
      onToggleSelect={() => (rowSelected = !rowSelected)}
      onEdit={() => {}}
      onRefresh={() => {}}
      onRemove={() => {}}
      onPark={() => {}}
    />
  </Case>

  <Case
    name="SourceRow · error"
    note="Hover or focus the badge for full error details; Tab reaches Technical details, Escape closes."
    frame
  >
    <SourceRow
      iconUrl={FAVICON}
      title="Flaky Feed"
      subtitle="flaky.example.com · last fetch failed"
      hasError
      errorDetails={{
        title: 'Service Unavailable',
        description: "The feed's server is temporarily unavailable for maintenance.",
        isPermanent: false,
        errorCount: 3,
        errorCode: 'HTTP 503',
        rawError: 'Feed fetch failed (HTTP 503)',
      }}
      onToggleSelect={() => {}}
      onRefresh={() => {}}
      onRemove={() => {}}
    />
  </Case>

  <Case
    name="SourceRow · unsubscribed"
    note="subscribed=false dims the row; offers Subscribe / Reactivate."
    frame
  >
    <SourceRow
      iconUrl={null}
      title="Parked Blog"
      subtitle="parked.example.com"
      subscribed={false}
      fallbackIcon="rss"
      onToggleSelect={() => {}}
      onSubscribe={() => {}}
      onReactivate={() => {}}
    />
  </Case>

  <Case name="SourceRow · round avatar" note="iconRound for account-style sources." frame>
    <SourceRow
      iconUrl={AVATAR}
      iconRound
      title="alice.bsky.social"
      subtitle="Atmosphere account · 3 unread"
      onToggleSelect={() => {}}
      onRemove={() => {}}
    />
  </Case>

  <Case
    name="BulkActionBar"
    note="Fixed to the viewport bottom when shown — toggle it on."
    pad
    frame
  >
    <button class="btn ghost" onclick={() => (showBulkBar = !showBulkBar)}>
      {showBulkBar ? 'Hide' : 'Show'} bulk bar
    </button>
    {#if showBulkBar}
      <BulkActionBar
        selectionCount={3}
        folders={['News', 'Tech', 'Reading queue']}
        hasCategory={true}
        onAssignToFolder={() => {}}
        onRemoveFromFolder={() => {}}
        onBulkDelete={() => {}}
        onClearSelection={() => (showBulkBar = false)}
      />
    {/if}
  </Case>
</Showcase>

<style>
  .echo {
    margin: 0.75rem 0 0;
    font-size: var(--text-xs);
    color: var(--color-text-secondary, #777);
    font-family: monospace;
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
