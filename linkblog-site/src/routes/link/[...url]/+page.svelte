<script lang="ts">
  import { formatDate, hostnameOf, safeHttpUrl } from '$lib/fields';
  import {
    countPhrases,
    INDEX_MIN_PEOPLE,
    pageSections,
    hueClassFor,
    monogramFor,
    personName,
    profileUrl,
    relativeTime,
    type LinkEntry,
  } from '$lib/link';
  import { cleanDiscussionNote } from '$lib/discussionNote';
  import LaneIcon from '$lib/components/LaneIcon.svelte';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();

  const KICKER = 'Discussion across the Atmosphere';
  const OUTBOUND_REL = 'nofollow ugc noopener noreferrer';

  const link = $derived(data.kind === 'link' ? data : null);
  const page = $derived(link?.data ?? null);
  const articleUrl = $derived(link?.articleUrl ?? '');
  const host = $derived(hostnameOf(articleUrl) ?? '');
  const title = $derived(page?.meta?.title || shortUrl(articleUrl));
  const siteName = $derived(page?.meta?.siteName ?? null);
  const description = $derived(page?.meta?.description ?? null);
  const counts = $derived(page ? countPhrases(page.lanes) : []);
  // Each lane's own verb ("posted", "noted"), as the proxy names it.
  const laneVerbs = $derived(new Map((page?.lanes ?? []).map((lane) => [lane.lane, lane.verb])));
  const laneLabels = $derived(new Map((page?.lanes ?? []).map((lane) => [lane.lane, lane.label])));
  const sections = $derived(page ? pageSections(page) : null);
  const people = $derived(
    sections
      ? new Set([...sections.highlights, ...sections.discussion, ...sections.saves].map((e) => e.did))
          .size
      : 0
  );
  const looking = $derived(link?.status === 'ok' && page?.pending === true);
  const quiet = $derived(
    link?.status === 'ok' && !page?.pending && !page?.unavailable && (page?.total ?? 0) === 0
  );
  const indexable = $derived(
    link?.status === 'ok' && !page?.pending && !page?.unavailable && people >= INDEX_MIN_PEOPLE
  );
  const saveUrl = $derived(`${data.appUrl}/save?url=${encodeURIComponent(articleUrl)}`);
  const subscribeUrl = $derived(`${data.appUrl}/subscribe?url=${encodeURIComponent(articleUrl)}`);
  // What "Subscribe to …" names: the site's own name, else its host.
  const publication = $derived(siteName?.trim() || host);
  const ogDescription = $derived(
    counts.join(' · ') || description || `What people said about ${host}`
  );

  // The article's address without its scheme, for when the page names no title.
  function shortUrl(url: string): string {
    return url.replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, '');
  }

  function outbound(entry: LinkEntry): string | null {
    return safeHttpUrl(entry.url ?? undefined);
  }

</script>

<svelte:head>
  {#if link}
    <title>{title} · {KICKER}</title>
    <meta name="description" content={ogDescription} />
    {#if !indexable}<meta name="robots" content="noindex" />{/if}
    {#if link.refreshUrl}<meta http-equiv="refresh" content={`4;url=${link.refreshUrl}`} />{/if}
    <meta property="og:type" content="website" />
    <meta property="og:site_name" content="Skyreader" />
    <meta property="og:title" content={`${title} · ${KICKER}`} />
    <meta property="og:description" content={ogDescription} />
    <meta property="og:url" content={link.pageUrl} />
    <meta property="og:image" content={link.imageUrl} />
    <meta property="og:image:width" content="1200" />
    <meta property="og:image:height" content="630" />
    <meta property="og:image:alt" content={KICKER} />
    <meta name="twitter:card" content="summary_large_image" />
    <meta name="twitter:title" content={`${title} · ${KICKER}`} />
    <meta name="twitter:description" content={ogDescription} />
    <meta name="twitter:image" content={link.imageUrl} />
    <link rel="canonical" href={link.pageUrl} />
  {:else}
    <title>{KICKER} · Skyreader</title>
    <meta name="description" content="See what people across the Atmosphere said about any link." />
  {/if}
</svelte:head>

{#if link}
  <article class="linkpage">
    <p class="kicker">{KICKER}</p>
    <h1 class="entry-title-lg">
      <a href={articleUrl} rel={OUTBOUND_REL}>{title}</a>
    </h1>
    <p class="link-source">
      {#if siteName && siteName.toLowerCase() !== host.toLowerCase()}{siteName}{' · '}{/if}<span
        class="link-host">{host}</span
      >
    </p>
    {#if description}<p class="link-desc">{description}</p>{/if}
    <a class="readmore" href={articleUrl} rel={OUTBOUND_REL}>
      Read on {host} <span class="arrow" aria-hidden="true">→</span>
    </a>

    <!-- Both hand off to the app, which signs the reader in (or up) first when
         needed and then finishes the job: /save saves the article, /subscribe
         finds the publication's feed from the article page. -->
    <div class="link-actions">
      <a class="link-action primary" href={saveUrl}>Save to Skyreader</a>
      <a class="link-action" href={subscribeUrl}
        >Subscribe to <span class="link-action-name">{publication}</span></a
      >
    </div>

    {#if link.status === 'busy'}
      <p class="link-state">Lots of people are looking right now. Try again in a minute.</p>
    {:else if link.status === 'unavailable' || page?.unavailable}
      <p class="link-state">The Atmosphere isn't answering right now. Try again in a minute.</p>
    {:else if looking && link.refreshUrl}
      <p class="link-state">Looking across the Atmosphere…</p>
    {:else if looking}
      <p class="link-state">Still looking. Reload in a little while.</p>
    {/if}

    {#if counts.length}
      <p class="link-counts">
        {#each counts as part, i (i)}{#if i > 0}{' · '}{/if}<span>{part}</span>{/each}
      </p>
    {/if}

    {#if sections?.highlights.length}
      <section class="link-section">
        <h2>Highlights</h2>
        <ul class="link-list">
          {#each sections.highlights as entry (entry.did)}
            {@render row(entry, 'margin', entry.verb || 'highlighted')}
          {/each}
        </ul>
      </section>
    {/if}

    {#if sections?.discussion.length}
      <section class="link-section">
        <h2>Discussion</h2>
        <ul class="link-list">
          {#each sections.discussion as entry (`${entry.lane}:${entry.did}`)}
            {@render row(entry, entry.lane, entry.verb || laneVerbs.get(entry.lane) || 'wrote')}
          {/each}
        </ul>
      </section>
    {/if}

    {#if sections?.saves.length}
      <section class="link-section">
        <h2>Saved in</h2>
        <ul class="link-list">
          {#each sections.saves as entry (entry.did)}
            {@render row(entry, 'semble', 'saved')}
          {/each}
        </ul>
      </section>
    {/if}

    {#if quiet}
      <p class="link-state">No one in the Atmosphere has talked about this yet.</p>
    {/if}

    <aside class="link-cta">
      <p class="link-cta-title">
        {quiet ? 'Be the first to note it.' : 'Follow what people say about what you read.'}
      </p>
      <p class="link-cta-sub">
        Skyreader brings your reading, and the conversation around it, into one calm place.
      </p>
      <a class="link-cta-button" href={saveUrl}>Sign in / create an account</a>
    </aside>
  </article>
{:else}
  <div class="linkpage">
    <p class="kicker">Skyreader</p>
    <h1 class="entry-title-lg">{KICKER}</h1>
    <p class="link-desc">
      See who posted, noted, highlighted and saved any article. Paste a link, or put
      <code>read.skyreader.app/</code> in front of one.
    </p>
    <form class="link-form" method="GET">
      <label class="visually-hidden" for="link-url">Article link</label>
      <input
        id="link-url"
        name="url"
        type="text"
        inputmode="url"
        autocomplete="off"
        placeholder="https://…"
        required
      />
      <button type="submit">Look it up</button>
    </form>
    {#if data.kind === 'landing' && data.invalid}
      <p class="link-state">That doesn't look like a link to an article.</p>
    {/if}
  </div>
{/if}

<footer class="foot">
  Public posts, notes and highlights from the Atmosphere, gathered by
  <a href={data.appUrl}>Skyreader</a>.
</footer>

<!-- One person's row, laid out like the reader's Discussion panel: who first
     (avatar wearing its network, name, handle, verb, time), then what they said
     in ink. -->
{#snippet row(entry: LinkEntry, lane: string, verb: string)}
  {@const profile = profileUrl(entry)}
  {@const permalink = outbound(entry)}
  {@const when = relativeTime(entry.createdAt)}
  {@const note = cleanDiscussionNote(entry.note, page?.meta?.title)}
  {@const name = personName(entry)}
  <li class="link-row">
    <svelte:element
      this={profile ? 'a' : 'span'}
      class="link-avatar {hueClassFor(entry.did)}"
      href={profile ?? undefined}
      rel={profile ? OUTBOUND_REL : undefined}
      aria-label={profile ? name : undefined}
    >
      <span class="link-monogram" aria-hidden="true">{monogramFor(entry)}</span>
      {#if safeHttpUrl(entry.avatar ?? undefined)}
        <img
          class="link-photo"
          src={safeHttpUrl(entry.avatar ?? undefined)}
          alt=""
          loading="lazy"
          decoding="async"
        />
      {/if}
      <span class="link-lane" title={laneLabels.get(lane) ?? lane}
        ><LaneIcon name={lane} size={10} /></span
      >
    </svelte:element>
    <div class="link-body">
      <p class="link-head">
        {#if profile}<a class="link-name" href={profile} rel={OUTBOUND_REL}>{name}</a
          >{:else}<span class="link-name">{name}</span>{/if}
        {#if entry.displayName?.trim() && entry.handle}
          <span class="link-handle">@{entry.handle}</span>
        {/if}
        <span class="link-meta">
          <span>{verb}</span>
          {#if when}
            <span aria-hidden="true">·</span>
            <time datetime={entry.createdAt} title={formatDate(entry.createdAt ?? '')}>{when}</time>
          {/if}
          {#if permalink}
            <a
              class="link-out"
              href={permalink}
              rel={OUTBOUND_REL}
              title={`Open on ${laneLabels.get(lane) ?? lane}`}
              aria-label={`Open on ${laneLabels.get(lane) ?? lane}`}><LaneIcon name="external" size={13} /></a
            >
          {/if}
        </span>
      </p>
      {#if entry.quote}<blockquote class="link-quote">{entry.quote}</blockquote>{/if}
      {#if note}<p class="link-note">{note}</p>{/if}
      {#if entry.collections.length}
        <p class="link-collections">
          {#each entry.collections as collection, i (i)}
            {#if safeHttpUrl(collection.url ?? undefined)}
              <a class="link-collection" href={safeHttpUrl(collection.url ?? undefined)} rel={OUTBOUND_REL}
                >{collection.name}</a
              >
            {:else}<span class="link-collection">{collection.name}</span>{/if}
          {/each}
        </p>
      {/if}
    </div>
  </li>
{/snippet}
