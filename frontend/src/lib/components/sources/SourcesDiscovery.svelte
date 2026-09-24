<script module lang="ts">
  /** A publication detected on the account of someone the reader already follows here. */
  export interface AuthorPublication {
    did: string;
    handle: string;
    avatarUrl: string | null;
    uri: string;
    name: string;
    url: string;
    iconUrl?: string;
  }
</script>

<script lang="ts">
  // "Find more": every way Skyreader can suggest a source, folded into one list
  // of ordinary source rows with an Add button. It used to be four sub-panels
  // (friends' linkblogs, standard.site subscriptions, follows' publications,
  // registry linkblogs), each with its own row style, plus a fifth kind of
  // suggestion faded into the reader's own Atmosphere list. Now a suggestion
  // looks like the source it would become, and the subtitle says whose it is.
  import { onMount } from 'svelte';
  import { standardSubsStore } from '$lib/stores/standardSubs.svelte';
  import { subscriptionsStore } from '$lib/stores/subscriptions.svelte';
  import { linkblogDiscoveryStore } from '$lib/stores/linkblogDiscovery.svelte';
  import { followingPublicationsStore } from '$lib/stores/followingPublications.svelte';
  import { fetchAllDocuments } from '$lib/services/feedFetcher';
  import { getFaviconUrl } from '$lib/utils/favicon';
  import { api, SubscriptionLimitError } from '$lib/services/api';
  import Icon from '$lib/components/Icon.svelte';
  import LimitNotice from '$lib/components/LimitNotice.svelte';
  import ShowMoreButton from '$lib/components/ShowMoreButton.svelte';
  import SourceRow from './SourceRow.svelte';
  import SourceList from './SourceList.svelte';
  import SourceSectionHeader from './SourceSectionHeader.svelte';
  import { feedLimitLine } from '$lib/utils/limitCopy';

  interface Props {
    /** More publications from Atmosphere accounts the reader already subscribes to. */
    authorPublications?: AuthorPublication[];
  }

  let { authorPublications = [] }: Props = $props();

  const FOLLOWS_WINDOW = 5;
  const FOLLOWS_STEP = 10;
  const REGISTRY_LIMIT = 3;

  // When Atmospheric sync is on, standard.site follows are imported and
  // reconciled automatically, so they're not offered one by one here.
  let pdsSyncEnabled = $state(false);

  onMount(async () => {
    standardSubsStore.load();
    linkblogDiscoveryStore.loadFriends();
    linkblogDiscoveryStore.loadDiscover();
    followingPublicationsStore.load();
    try {
      const settings = await api.getSettings();
      pdsSyncEnabled = settings.pdsSyncEnabled;
    } catch {
      // Non-fatal: fall back to offering them manually.
    }
  });

  interface Suggestion {
    key: string;
    title: string;
    subtitle: string;
    iconUrl: string | null;
    iconRound: boolean;
    fallbackIcon: string;
    add: () => Promise<void>;
  }

  function formatUrl(url: string): string {
    return url.replace(/^https?:\/\//, '').replace(/\/$/, '');
  }

  function at(handle: string | null | undefined, did: string): string {
    return handle && !handle.startsWith('did:') ? `@${handle}` : did;
  }

  let subscribedPubUris = $derived(
    new Set(
      subscriptionsStore.subscriptions
        .filter((s) => s.sourceType === 'atproto.documents' && s.feedUrl)
        .map((s) => s.feedUrl as string)
    )
  );

  let subscribedDids = $derived(
    new Set(
      subscriptionsStore.subscriptions
        .filter((s) => s.subjectDid)
        .map((s) => s.subjectDid as string)
    )
  );

  async function addAuthorPublication(p: AuthorPublication) {
    const id = await subscriptionsStore.add(p.uri, p.name || p.url, {
      sourceType: 'atproto.documents',
      subjectDid: p.did,
      siteUrl: p.url,
      feedUrl: p.uri,
    });
    if (p.iconUrl) await subscriptionsStore.updateLocal(id, { customIconUrl: p.iconUrl });
    // Fetch its documents now so the feed isn't empty until the next refresh.
    void fetchAllDocuments(subscriptionsStore.subscriptions);
  }

  // People the reader follows, in the order most likely to be wanted: more from
  // authors already here, then their own standard.site follows, then friends'
  // linkblogs, then publications found across the follow graph. One URI, one row.
  let fromFollows = $derived.by((): Suggestion[] => {
    const out: Suggestion[] = [];
    const seen = new Set<string>(subscribedPubUris);
    const push = (s: Suggestion) => {
      if (seen.has(s.key)) return;
      seen.add(s.key);
      out.push(s);
    };

    for (const p of authorPublications) {
      push({
        key: p.uri,
        title: p.name || formatUrl(p.url),
        subtitle: `${at(p.handle, p.did)} · ${formatUrl(p.url)}`,
        iconUrl: p.iconUrl || p.avatarUrl,
        iconRound: !p.iconUrl,
        fallbackIcon: 'standard-site',
        add: () => addAuthorPublication(p),
      });
    }

    if (!pdsSyncEnabled) {
      for (const sub of standardSubsStore.subs) {
        if (subscribedDids.has(sub.publisherDid)) continue;
        push({
          key: sub.publication.uri,
          title: sub.publication.name,
          subtitle: `${formatUrl(sub.publication.url)} · you subscribe on standard.site`,
          iconUrl: sub.publication.url ? getFaviconUrl(sub.publication.url, 64) : null,
          iconRound: false,
          fallbackIcon: 'standard-site',
          add: () => standardSubsStore.subscribe(sub),
        });
      }
    }

    for (const p of linkblogDiscoveryStore.friends) {
      push({
        key: p.publicationUri,
        title: p.displayName?.trim() || at(p.handle, p.did),
        subtitle: `${at(p.handle, p.did)} · Skyreader linkblog`,
        iconUrl: p.avatar ?? null,
        iconRound: true,
        fallbackIcon: 'link',
        add: () => linkblogDiscoveryStore.subscribe(p),
      });
    }

    for (const p of followingPublicationsStore.publications) {
      push({
        key: p.publicationUri,
        title: p.name?.trim() || formatUrl(p.url),
        subtitle: `${at(p.handle, p.did)} · ${formatUrl(p.url)}`,
        iconUrl: p.iconUrl || p.avatar || null,
        iconRound: !p.iconUrl,
        fallbackIcon: 'standard-site',
        add: () => followingPublicationsStore.subscribe(p),
      });
    }
    return out;
  });

  // Linkblogs from the wider registry: people the reader doesn't follow yet.
  let fromRegistry = $derived.by((): Suggestion[] => {
    const shown = new Set(fromFollows.map((s) => s.key));
    return linkblogDiscoveryStore.people
      .filter(
        (p) =>
          !p.isFollow && !subscribedPubUris.has(p.publicationUri) && !shown.has(p.publicationUri)
      )
      .map((p) => ({
        key: p.publicationUri,
        title: p.displayName?.trim() || at(p.handle, p.did),
        subtitle: `${at(p.handle, p.did)} · Skyreader linkblog`,
        iconUrl: p.avatar ?? null,
        iconRound: true,
        fallbackIcon: 'link',
        add: () => linkblogDiscoveryStore.subscribe(p),
      }));
  });

  let followsWindow = $state(FOLLOWS_WINDOW);
  let visibleFollows = $derived(fromFollows.slice(0, followsWindow));
  let visibleRegistry = $derived(fromRegistry.slice(0, REGISTRY_LIMIT));

  let searching = $derived(
    !standardSubsStore.loaded ||
      !linkblogDiscoveryStore.friendsLoaded ||
      !linkblogDiscoveryStore.peopleLoaded ||
      !followingPublicationsStore.loaded
  );

  // One notice for the whole list: the active-feed cap is the same wall for
  // every row, and any other failure is rare enough to say once.
  let pending = $state<string | null>(null);
  let addError = $state<string | null>(null);
  let limitHit = $state(false);

  async function add(s: Suggestion) {
    if (pending) return;
    pending = s.key;
    addError = null;
    limitHit = false;
    try {
      await s.add();
    } catch (e) {
      if (e instanceof SubscriptionLimitError) limitHit = true;
      else addError = e instanceof Error ? e.message : 'Could not add that source.';
    } finally {
      pending = null;
    }
  }
</script>

{#snippet row(s: Suggestion)}
  <SourceRow
    iconUrl={s.iconUrl}
    iconRound={s.iconRound}
    title={s.title}
    subtitle={s.subtitle}
    subscribed={false}
    fallbackIcon={s.fallbackIcon}
    pending={pending === s.key}
    onSubscribe={() => add(s)}
  />
{/snippet}

<section class="discovery">
  <SourceSectionHeader title="Find more">
    <a class="browse" href="/discover">
      Browse all
      <Icon name="chevron-right" size={14} />
    </a>
  </SourceSectionHeader>

  {#if limitHit}
    <div class="notice">
      <LimitNotice kind="feeds">
        <p>{feedLimitLine(subscriptionsStore.maxSubscriptions)}</p>
      </LimitNotice>
    </div>
  {:else if addError}
    <p class="status error">{addError}</p>
  {/if}

  {#if visibleFollows.length > 0}
    <SourceList label="From people you follow" count={fromFollows.length}>
      {#each visibleFollows as s (s.key)}
        {@render row(s)}
      {/each}
      <ShowMoreButton
        remaining={fromFollows.length - followsWindow}
        batchSize={FOLLOWS_STEP}
        onclick={() => (followsWindow += FOLLOWS_STEP)}
      />
    </SourceList>
  {/if}

  {#if visibleRegistry.length > 0}
    <SourceList label="Skyreader linkblogs">
      {#each visibleRegistry as s (s.key)}
        {@render row(s)}
      {/each}
    </SourceList>
  {/if}

  {#if visibleFollows.length === 0 && visibleRegistry.length === 0}
    <p class="status">
      {searching ? 'Looking for sources…' : 'Nothing new to suggest right now.'}
    </p>
  {/if}

  {#if pdsSyncEnabled && standardSubsStore.loaded && standardSubsStore.subs.length > 0}
    <p class="status synced">
      <Icon name="check" size={14} />
      Your standard.site subscriptions sync automatically.
    </p>
  {/if}
</section>

<style>
  .discovery {
    margin-top: 2.5rem;
  }

  .browse {
    display: inline-flex;
    align-items: center;
    gap: 0.125rem;
    font-size: var(--text-sm);
    font-weight: var(--weight-medium);
    color: var(--color-primary);
    text-decoration: none;
  }

  .browse:hover {
    text-decoration: underline;
  }

  .notice {
    margin-bottom: 0.75rem;
  }

  .status {
    margin: 0.25rem 0.25rem 0;
    font-size: var(--text-sm);
    color: var(--color-text-secondary);
    line-height: var(--leading-normal);
  }

  .status.error {
    margin-bottom: 0.5rem;
    color: var(--color-error);
  }

  .status.synced {
    display: flex;
    align-items: center;
    gap: 0.375rem;
    margin-top: 0.75rem;
  }
</style>
