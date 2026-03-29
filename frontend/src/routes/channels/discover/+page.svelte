<script lang="ts">
  import { goto } from '$app/navigation';
  import { channelSuggestions } from '$lib/stores/channelSuggestions.svelte';
  import { filteredViewsStore } from '$lib/stores/filteredViews.svelte';
  import { feedViewStore } from '$lib/stores/feedView.svelte';
  import { mobileStore } from '$lib/stores/mediaQuery.svelte';
  import Icon from '$lib/components/Icon.svelte';
  import MobileFeedSwitcher from '$lib/components/feed/MobileFeedSwitcher.svelte';
  import BottomSheet from '$lib/components/common/BottomSheet.svelte';
  import type { ChannelSuggestion } from '$lib/stores/channelSuggestions.svelte';

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

  // All possible channel types with descriptions, even when they don't currently match
  const CHANNEL_TYPES = [
    {
      id: 'frequency:high',
      name: 'Daily Digest',
      icon: 'inbox' as const,
      description:
        'Groups high-volume feeds that publish multiple times per day. Helps you skim the firehose without it drowning out quieter sources.',
    },
    {
      id: 'frequency:low',
      name: "Don't Miss",
      icon: 'bookmark' as const,
      description:
        "Collects feeds that publish infrequently — personal blogs, monthly newsletters, and thoughtful writers where every post matters. You won't lose them in the noise.",
    },
    {
      id: 'content:longreads',
      name: 'Long Reads',
      icon: 'file-text' as const,
      description:
        'Feeds with in-depth, long-form articles (1000+ words on average). Perfect for weekend reading or deep dives.',
    },
    {
      id: 'people:all',
      name: 'People I Follow',
      icon: 'users' as const,
      description:
        'Everything from the people you follow on Bluesky — their shared articles and published documents in one place.',
    },
    {
      id: 'type:articles',
      name: 'Articles',
      icon: 'rss' as const,
      description:
        'Only RSS feed articles, with social content filtered out. A clean reading experience for traditional blog and news content.',
    },
    {
      id: 'type:social',
      name: 'Social',
      icon: 'share' as const,
      description:
        'Only content from people you follow — shares and published documents, without RSS articles mixed in.',
    },
    {
      id: 'recent:new',
      name: 'New Sources',
      icon: 'plus' as const,
      description:
        "Sources you've added in the last 2 weeks. A temporary channel to help you get to know new subscriptions before they blend into the mix.",
    },
    {
      id: 'domain:newsletters',
      name: 'Newsletters',
      icon: 'newspaper' as const,
      description:
        'Groups feeds from newsletter platforms like Substack, Buttondown, Ghost, and Beehiiv.',
    },
    {
      id: 'domain:podcasts',
      name: 'Podcasts',
      icon: 'newspaper' as const,
      description: 'Groups podcast feeds from platforms like Transistor, Buzzsprout, and Libsyn.',
    },
    {
      id: 'domain:reddit',
      name: 'Reddit',
      icon: 'newspaper' as const,
      description: 'Groups all your Reddit RSS feeds into one channel.',
    },
    {
      id: 'domain:github',
      name: 'GitHub',
      icon: 'newspaper' as const,
      description: 'Groups GitHub release feeds and activity feeds.',
    },
  ];

  // Map active suggestions by ID for quick lookup
  let activeSuggestionMap = $derived(
    new Map(channelSuggestions.allSuggestions.map((s) => [s.id, s]))
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
  {#if channelSuggestions.allSuggestions.length > 0}
    <section class="section">
      <h2 class="section-title">Suggested for you</h2>
      <p class="section-desc">
        Based on your current sources, these channels would help organize your reading.
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
      </div>
    </section>
  {/if}

  <!-- All channel types -->
  <section class="section">
    <h2 class="section-title">All channel types</h2>
    <p class="section-desc">
      These are all the kinds of channels Skyreader can suggest. Channels that match your sources
      can be created instantly. Others will appear as suggestions when you add the right sources.
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
          {#if activeSuggestion && !alreadyCreated}
            <div class="card-actions">
              <button class="create-btn" onclick={() => acceptSuggestion(activeSuggestion)}>
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
    font-size: 1.25rem;
    font-weight: 600;
    margin: 0 0 0.5rem;
  }

  .header-desc {
    font-size: 0.875rem;
    color: var(--color-text-secondary);
    line-height: 1.5;
    margin: 0;
  }

  .section {
    margin-bottom: 2rem;
  }

  .section-title {
    font-size: 0.9375rem;
    font-weight: 600;
    margin: 0 0 0.25rem;
  }

  .section-desc {
    font-size: 0.8125rem;
    color: var(--color-text-secondary);
    line-height: 1.5;
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
    font-size: 0.9375rem;
    font-weight: 600;
    margin: 0;
    flex: 1;
  }

  .card-badge {
    font-size: 0.625rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.03em;
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
    font-size: 0.8125rem;
    color: var(--color-text);
    line-height: 1.5;
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
    font-size: 0.8125rem;
    font-weight: 500;
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
    font-size: 0.8125rem;
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
    font-size: 0.875rem;
    font-weight: 500;
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
