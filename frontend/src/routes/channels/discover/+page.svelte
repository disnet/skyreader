<script lang="ts">
  import { goto } from '$app/navigation';
  import { channelSuggestions } from '$lib/stores/channelSuggestions.svelte';
  import {
    savedChannelSuggestions,
    type SavedChannelSuggestion,
  } from '$lib/stores/savedChannelSuggestions.svelte';
  import { filteredViewsStore } from '$lib/stores/filteredViews.svelte';
  import { feedViewStore } from '$lib/stores/feedView.svelte';
  import { mobileStore } from '$lib/stores/mediaQuery.svelte';
  import { DOMAIN_CLUSTERS } from '$lib/utils/channelLogic';
  import Icon from '$lib/components/Icon.svelte';
  import MobileFeedSwitcher from '$lib/components/feed/MobileFeedSwitcher.svelte';
  import BottomSheet from '$lib/components/common/BottomSheet.svelte';
  import type { ChannelSuggestion } from '$lib/stores/channelSuggestions.svelte';
  import type {
    ChannelAutoRule,
    SavedSourceType,
    ReadingLengthFilter,
    SortOrder,
  } from '$lib/types';

  let feedSwitcherOpen = $state(false);

  async function acceptSuggestion(suggestion: ChannelSuggestion) {
    const id = await filteredViewsStore.create({
      name: suggestion.name,
      sourceMode: suggestion.sourceMode,
      sourceKeys: suggestion.sourceKeys,
      typeFilter: suggestion.typeFilter.length > 0 ? suggestion.typeFilter : undefined,
      autoRule: suggestion.autoRule,
      readFilter: 'unread',
      sortOrder: 'newest',
    });
    goto(`/?view=${id}`);
  }

  async function acceptSavedSuggestion(suggestion: SavedChannelSuggestion) {
    const id = await filteredViewsStore.create({
      name: suggestion.name,
      mode: 'saved',
      savedSourceFilter: suggestion.savedSourceFilter,
      savedDomainFilter: suggestion.savedDomainFilter,
      savedReadingLength: suggestion.savedReadingLength,
      savedDateFilter: suggestion.savedDateFilter,
      readFilter: suggestion.readFilter ?? 'unread',
      sortOrder: suggestion.sortOrder ?? 'newest',
    });
    goto(`/?view=${id}`);
  }

  async function createChannelFromType(type: ChannelTypeConfig) {
    const id = await filteredViewsStore.create({
      name: type.name,
      sourceMode: type.sourceMode,
      sourceKeys: [],
      typeFilter: type.typeFilter,
      autoRule: type.autoRule,
      readFilter: 'unread',
      sortOrder: 'newest',
    });
    goto(`/?view=${id}`);
  }

  async function createSavedChannelFromType(type: SavedChannelTypeConfig) {
    const id = await filteredViewsStore.create({
      name: type.name,
      mode: 'saved',
      savedSourceFilter: type.savedSourceFilter,
      savedReadingLength: type.savedReadingLength,
      readFilter: 'unread',
      sortOrder: type.sortOrder ?? 'newest',
    });
    goto(`/?view=${id}`);
  }

  // All possible channel types with descriptions and default creation config
  interface ChannelTypeConfig {
    id: string;
    name: string;
    icon: 'inbox' | 'bookmark' | 'file-text' | 'users' | 'rss' | 'share' | 'plus' | 'newspaper';
    description: string;
    sourceMode: 'all' | 'include';
    typeFilter?: ('rss' | 'atproto.documents')[];
    autoRule?: ChannelAutoRule;
  }

  const CHANNEL_TYPES: ChannelTypeConfig[] = [
    {
      id: 'frequency:high',
      name: 'Daily Digest',
      icon: 'inbox',
      description:
        'Groups high-volume feeds that publish multiple times per day. Helps you skim the firehose without it drowning out quieter sources.',
      sourceMode: 'include',
      autoRule: { type: 'frequency', threshold: 'high' },
    },
    {
      id: 'frequency:low',
      name: "Don't Miss",
      icon: 'bookmark',
      description:
        "Collects feeds that publish infrequently — personal blogs, monthly newsletters, and thoughtful writers where every post matters. You won't lose them in the noise.",
      sourceMode: 'include',
      autoRule: { type: 'frequency', threshold: 'low' },
    },
    {
      id: 'content:longreads',
      name: 'Long Reads',
      icon: 'file-text',
      description:
        'Feeds with in-depth, long-form articles (1000+ words on average). Perfect for weekend reading or deep dives.',
      sourceMode: 'include',
      autoRule: { type: 'longReads', minLength: 5000 },
    },
    {
      id: 'people:all',
      name: 'People I Follow',
      icon: 'users',
      description:
        'Everything from the people you follow on Bluesky — their shared articles and published documents in one place.',
      sourceMode: 'include',
      autoRule: { type: 'people' },
    },
    {
      id: 'type:articles',
      name: 'Articles',
      icon: 'rss',
      description:
        'Only RSS feed articles, with social content filtered out. A clean reading experience for traditional blog and news content.',
      sourceMode: 'all',
      typeFilter: ['rss'],
    },
    {
      id: 'type:social',
      name: 'Social',
      icon: 'share',
      description:
        'Only content from people you follow — published documents and linkblog posts, without RSS articles mixed in.',
      sourceMode: 'all',
      typeFilter: ['atproto.documents'],
    },
    {
      id: 'recent:new',
      name: 'New Sources',
      icon: 'plus',
      description:
        "Sources you've added in the last 2 weeks. A temporary channel to help you get to know new subscriptions before they blend into the mix.",
      sourceMode: 'include',
      autoRule: { type: 'recent', withinDays: 14 },
    },
    ...DOMAIN_CLUSTERS.map((cluster) => ({
      id: cluster.id,
      name: cluster.name,
      icon: 'newspaper' as const,
      description: cluster.description,
      sourceMode: 'include' as const,
      autoRule: { type: 'domain' as const, patterns: [...cluster.patterns] },
    })),
  ];

  // Saved channel types with descriptions and default creation config
  interface SavedChannelTypeConfig {
    id: string;
    name: string;
    icon: 'rss' | 'link' | 'file-text' | 'clock' | 'share' | 'newspaper';
    description: string;
    savedSourceFilter?: SavedSourceType[];
    savedReadingLength?: ReadingLengthFilter[];
    sortOrder?: SortOrder;
  }

  const SAVED_CHANNEL_TYPES: SavedChannelTypeConfig[] = [
    {
      id: 'saved:source-feed',
      name: 'Saved from Feeds',
      icon: 'rss',
      description:
        'Articles you saved from your RSS feeds. Keep feed bookmarks separate from web saves.',
      savedSourceFilter: ['feed'],
    },
    {
      id: 'saved:source-url',
      name: 'Saved from Web',
      icon: 'link',
      description:
        'Pages you saved by URL. A dedicated channel for articles and pages you found outside your feeds.',
      savedSourceFilter: ['url'],
    },
    {
      id: 'saved:long-reads',
      name: 'Saved Long Reads',
      icon: 'file-text',
      description:
        'Saved items with 15+ minute read time. Queue up your long-form reading for when you have the time.',
      savedReadingLength: ['long'],
      sortOrder: 'longest',
    },
    {
      id: 'saved:quick-reads',
      name: 'Saved Quick Reads',
      icon: 'clock',
      description: 'Saved items you can finish in under 5 minutes. Perfect for short breaks.',
      savedReadingLength: ['quick'],
      sortOrder: 'shortest',
    },
    {
      id: 'saved:source-document',
      name: 'Saved Documents',
      icon: 'newspaper',
      description:
        'Published documents you bookmarked. Long-form writing from the people you follow.',
      savedSourceFilter: ['document'],
    },
  ];

  // Map active suggestions by ID for quick lookup
  let activeSuggestionMap = $derived(
    new Map(channelSuggestions.allSuggestions.map((s) => [s.id, s]))
  );

  // Map active saved suggestions by ID for quick lookup
  let activeSavedSuggestionMap = $derived(
    new Map(savedChannelSuggestions.allSuggestions.map((s) => [s.id, s]))
  );

  // IDs of channels that already exist
  let existingChannelNames = $derived(
    new Set(filteredViewsStore.views.map((v) => v.name.toLowerCase()))
  );
</script>

<svelte:head>
  <title>Discover Channels - Skyreader</title>
</svelte:head>

<div class="discover-page">
  <header class="discover-header">
    <h1>Discover Channels</h1>
    <p class="header-desc">
      Channels are smart filtered views of your content. They automatically group your sources by
      topic, frequency, content type, or other patterns. Create one with a single tap — and they
      stay up to date as you add new sources.
    </p>
  </header>

  <!-- Active suggestions -->
  {#if channelSuggestions.allSuggestions.length > 0 || savedChannelSuggestions.allSuggestions.length > 0}
    <section class="section">
      <h2 class="section-title">Suggested for you</h2>
      <p class="section-desc">
        Based on your current sources and saved items, these channels would help organize your
        reading.
      </p>
      <div class="channel-grid">
        {#each channelSuggestions.allSuggestions as suggestion (suggestion.id)}
          {@const type = CHANNEL_TYPES.find((t) => t.id === suggestion.id)}
          <div class="channel-card active">
            <div class="card-header">
              <span class="card-icon">
                <Icon name={type?.icon ?? 'newspaper'} size={18} />
              </span>
              <h3>{suggestion.name}</h3>
            </div>
            <p class="card-desc">{suggestion.description}</p>
            <div class="card-actions">
              <button class="create-btn" onclick={() => acceptSuggestion(suggestion)}>
                <Icon name="plus" size={14} />
                Create channel
              </button>
              <button class="dismiss-btn" onclick={() => channelSuggestions.dismiss(suggestion.id)}>
                Dismiss
              </button>
            </div>
          </div>
        {/each}
        {#each savedChannelSuggestions.allSuggestions as suggestion (suggestion.id)}
          {@const type = SAVED_CHANNEL_TYPES.find((t) => t.id === suggestion.id)}
          <div class="channel-card active">
            <div class="card-header">
              <span class="card-icon">
                <Icon name={type?.icon ?? 'bookmark'} size={18} />
              </span>
              <h3>{suggestion.name}</h3>
            </div>
            <p class="card-desc">{suggestion.description}</p>
            <div class="card-actions">
              <button class="create-btn" onclick={() => acceptSavedSuggestion(suggestion)}>
                <Icon name="plus" size={14} />
                Create channel
              </button>
              <button
                class="dismiss-btn"
                onclick={() => savedChannelSuggestions.dismiss(suggestion.id)}
              >
                Dismiss
              </button>
            </div>
          </div>
        {/each}
      </div>
    </section>
  {/if}

  <!-- All channel types -->
  <section class="section">
    <h2 class="section-title">All channel types</h2>
    <p class="section-desc">
      These are all the kinds of channels Skyreader can create. Channels with matching sources are
      highlighted, but you can create any channel — it will populate as you add matching sources.
    </p>
    <div class="channel-grid">
      {#each CHANNEL_TYPES as type (type.id)}
        {@const activeSuggestion = activeSuggestionMap.get(type.id)}
        {@const alreadyCreated = existingChannelNames.has(type.name.toLowerCase())}
        <div
          class="channel-card"
          class:available={!!activeSuggestion}
          class:created={alreadyCreated}
        >
          <div class="card-header">
            <span class="card-icon">
              <Icon name={type.icon} size={18} />
            </span>
            <h3>{type.name}</h3>
            {#if alreadyCreated}
              <span class="card-badge created-badge">Created</span>
            {:else if activeSuggestion}
              <span class="card-badge available-badge">Available</span>
            {/if}
          </div>
          <p class="card-desc">{type.description}</p>
          {#if !alreadyCreated}
            <div class="card-actions">
              <button
                class="create-btn"
                onclick={() =>
                  activeSuggestion
                    ? acceptSuggestion(activeSuggestion)
                    : createChannelFromType(type)}
              >
                <Icon name="plus" size={14} />
                Create channel
              </button>
            </div>
          {/if}
        </div>
      {/each}

      <!-- Dynamic types: categories and tags -->
      {#each channelSuggestions.allSuggestions.filter((s) => s.id.startsWith('category:') || s.id.startsWith('tag:')) as suggestion (suggestion.id)}
        {@const isCategory = suggestion.id.startsWith('category:')}
        <div class="channel-card available">
          <div class="card-header">
            <span class="card-icon">
              <Icon name={isCategory ? 'layers' : 'tag'} size={18} />
            </span>
            <h3>{suggestion.name}</h3>
            <span class="card-badge available-badge">Available</span>
          </div>
          <p class="card-desc">{suggestion.description}</p>
          <div class="card-actions">
            <button class="create-btn" onclick={() => acceptSuggestion(suggestion)}>
              <Icon name="plus" size={14} />
              Create channel
            </button>
          </div>
        </div>
      {/each}
    </div>
  </section>

  <!-- Saved channel types -->
  <section class="section">
    <h2 class="section-title">Saved item channels</h2>
    <p class="section-desc">
      Create channels from your saved items to organize bookmarks by source, reading time, or
      domain.
    </p>
    <div class="channel-grid">
      {#each SAVED_CHANNEL_TYPES as type (type.id)}
        {@const activeSuggestion = activeSavedSuggestionMap.get(type.id)}
        {@const alreadyCreated = existingChannelNames.has(type.name.toLowerCase())}
        <div
          class="channel-card"
          class:available={!!activeSuggestion}
          class:created={alreadyCreated}
        >
          <div class="card-header">
            <span class="card-icon">
              <Icon name={type.icon} size={18} />
            </span>
            <h3>{type.name}</h3>
            {#if alreadyCreated}
              <span class="card-badge created-badge">Created</span>
            {:else if activeSuggestion}
              <span class="card-badge available-badge">Available</span>
            {/if}
          </div>
          <p class="card-desc">{type.description}</p>
          {#if !alreadyCreated}
            <div class="card-actions">
              <button
                class="create-btn"
                onclick={() =>
                  activeSuggestion
                    ? acceptSavedSuggestion(activeSuggestion)
                    : createSavedChannelFromType(type)}
              >
                <Icon name="plus" size={14} />
                Create channel
              </button>
            </div>
          {/if}
        </div>
      {/each}

      <!-- Dynamic types: domain-based saved channels -->
      {#each savedChannelSuggestions.allSuggestions.filter( (s) => s.id.startsWith('saved:domain-') ) as suggestion (suggestion.id)}
        <div class="channel-card available">
          <div class="card-header">
            <span class="card-icon">
              <Icon name="globe" size={18} />
            </span>
            <h3>{suggestion.name}</h3>
            <span class="card-badge available-badge">Available</span>
          </div>
          <p class="card-desc">{suggestion.description}</p>
          <div class="card-actions">
            <button class="create-btn" onclick={() => acceptSavedSuggestion(suggestion)}>
              <Icon name="plus" size={14} />
              Create channel
            </button>
          </div>
        </div>
      {/each}
    </div>
  </section>

  <!-- Custom channels callout -->
  <section class="section callout">
    <h2 class="section-title">Create your own</h2>
    <p class="section-desc">
      You can always create a custom channel from any view. Set up filters for specific sources,
      content types, or tags — then save it as a channel. Use the <strong>+</strong> button in the Channels
      section of the sidebar.
    </p>
  </section>
</div>

{#if mobileStore.isMobile}
  <div class="mobile-bottom-bar">
    <button class="switcher-pill" onclick={() => (feedSwitcherOpen = true)}>
      <span class="pill-icon"><Icon name="layers" size={20} /></span>
      <span class="pill-label">Discover Channels</span>
    </button>
  </div>

  <BottomSheet
    open={feedSwitcherOpen}
    onclose={() => (feedSwitcherOpen = false)}
    title="Switch Feed"
  >
    <MobileFeedSwitcher
      onclose={() => (feedSwitcherOpen = false)}
      currentTitle="Discover Channels"
    />
  </BottomSheet>
{/if}

<style>
  .discover-page {
    max-width: 720px;
    margin: 0 auto;
    padding: 1.5rem 1rem 3rem;
  }

  .discover-header {
    margin-bottom: 2rem;
  }

  h1 {
    font-size: var(--text-2xl);
    font-weight: var(--weight-semibold);
    margin: 0 0 0.5rem;
  }

  .header-desc {
    font-size: var(--text-md);
    color: var(--color-text-secondary);
    line-height: var(--leading-normal);
    margin: 0;
  }

  .section {
    margin-bottom: 2rem;
  }

  .section-title {
    font-size: var(--text-lg);
    font-weight: var(--weight-semibold);
    margin: 0 0 0.25rem;
  }

  .section-desc {
    font-size: var(--text-sm);
    color: var(--color-text-secondary);
    line-height: var(--leading-normal);
    margin: 0 0 1rem;
  }

  .channel-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
    gap: 0.75rem;
  }

  .channel-card {
    border: 1px solid var(--color-border);
    border-radius: 12px;
    padding: 1rem;
    transition:
      border-color 0.15s,
      background-color 0.15s;
  }

  .channel-card.available {
    border-color: var(--color-primary);
    background: rgba(0, 102, 204, 0.03);
  }

  .channel-card.created {
    opacity: 0.6;
  }

  .card-header {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin-bottom: 0.5rem;
  }

  .card-icon {
    display: flex;
    align-items: center;
    color: var(--color-text-secondary);
  }

  .channel-card.available .card-icon {
    color: var(--color-primary);
  }

  .card-header h3 {
    font-size: var(--text-lg);
    font-weight: var(--weight-semibold);
    margin: 0;
    flex: 1;
  }

  .card-badge {
    font-size: var(--text-3xs);
    font-weight: var(--weight-semibold);
    text-transform: uppercase;
    letter-spacing: var(--tracking-wide);
    padding: 0.125rem 0.375rem;
    border-radius: 4px;
    flex-shrink: 0;
  }

  .available-badge {
    background: rgba(0, 102, 204, 0.1);
    color: var(--color-primary);
  }

  .created-badge {
    background: rgba(0, 0, 0, 0.06);
    color: var(--color-text-secondary);
  }

  .card-desc {
    font-size: var(--text-sm);
    color: var(--color-text);
    line-height: var(--leading-normal);
    margin: 0 0 0.375rem;
  }

  .card-actions {
    display: flex;
    gap: 0.5rem;
    align-items: center;
  }

  .create-btn {
    display: flex;
    align-items: center;
    gap: 0.25rem;
    padding: 0.375rem 0.75rem;
    background: var(--color-primary);
    color: #fff;
    border: none;
    border-radius: 8px;
    cursor: pointer;
    font-size: var(--text-sm);
    font-weight: var(--weight-medium);
    transition: opacity 0.15s;
  }

  .create-btn:hover {
    opacity: 0.9;
  }

  .dismiss-btn {
    padding: 0.375rem 0.75rem;
    background: none;
    border: 1px solid var(--color-border);
    border-radius: 8px;
    cursor: pointer;
    font-size: var(--text-sm);
    color: var(--color-text-secondary);
  }

  .dismiss-btn:hover {
    background: var(--color-bg-hover);
  }

  .callout {
    background: var(--color-bg-secondary, rgba(0, 0, 0, 0.03));
    border-radius: 12px;
    padding: 1.25rem;
  }

  .callout .section-title {
    margin-bottom: 0.375rem;
  }

  .callout .section-desc {
    margin-bottom: 0;
  }

  @media (max-width: 1000px) {
    .discover-page {
      padding-bottom: 5rem;
    }
  }

  @media (max-width: 640px) {
    .channel-grid {
      grid-template-columns: 1fr;
    }
  }

  /* Mobile bottom bar */
  .mobile-bottom-bar {
    position: fixed;
    bottom: 0;
    left: 0;
    right: 0;
    padding: 0.75rem 1rem;
    padding-bottom: calc(0.75rem + env(safe-area-inset-bottom, 0px));
    z-index: 10;
    pointer-events: none;
  }

  .switcher-pill {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    background: rgba(255, 255, 255, 0.85);
    backdrop-filter: blur(8px);
    border-radius: 999px;
    padding: 0.25rem 0.75rem 0.25rem 0.5rem;
    box-shadow: 0 2px 12px rgba(0, 0, 0, 0.15);
    pointer-events: auto;
    border: none;
    color: var(--color-text);
    font-size: var(--text-md);
    font-weight: var(--weight-medium);
    max-width: 80%;
  }

  .switcher-pill:active {
    background: rgba(240, 240, 240, 0.95);
  }

  .pill-icon {
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 0.6rem;
    color: var(--color-text-secondary);
    flex-shrink: 0;
  }

  .pill-label {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  @media (min-width: 1001px) {
    .mobile-bottom-bar {
      display: none;
    }
  }

  @media (prefers-color-scheme: dark) {
    .channel-card.available {
      background: rgba(0, 102, 204, 0.06);
    }

    .created-badge {
      background: rgba(255, 255, 255, 0.08);
    }

    .callout {
      background: var(--color-bg-secondary, rgba(255, 255, 255, 0.04));
    }

    .switcher-pill {
      background: rgba(40, 40, 40, 0.95);
    }

    .switcher-pill:active {
      background: rgba(55, 55, 55, 0.95);
    }
  }
</style>
