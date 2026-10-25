<script lang="ts">
  import { formatDate, hostnameOf, safeHttpUrl } from '$lib/fields';
  import {
    countLine,
    INDEX_MIN_PEOPLE,
    pageSections,
    personName,
    profileUrl,
    type LinkEntry,
  } from '$lib/link';
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
  const counts = $derived(page ? countLine(page.lanes) : '');
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
  const ogDescription = $derived(counts || description || `What people said about ${host}`);

  // The article's address without its scheme, for when the page names no title.
  function shortUrl(url: string): string {
    return url.replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, '');
  }

  function outbound(entry: LinkEntry): string | null {
    return safeHttpUrl(entry.url ?? undefined);
  }

  const LANE_VERBS: Record<string, string> = {
    linkblog: 'noted',
    leaflet: 'commented',
    bluesky: 'posted',
    margin: 'annotated',
  };
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
    <meta name="twitter:card" content="summary" />
    <meta name="twitter:title" content={`${title} · ${KICKER}`} />
    <meta name="twitter:description" content={ogDescription} />
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

    {#if link.status === 'busy'}
      <p class="link-state">Lots of people are looking right now. Try again in a minute.</p>
    {:else if link.status === 'unavailable' || page?.unavailable}
      <p class="link-state">The Atmosphere isn't answering right now. Try again in a minute.</p>
    {:else if looking && link.refreshUrl}
      <p class="link-state">Looking across the Atmosphere…</p>
    {:else if looking}
      <p class="link-state">Still looking. Reload in a little while.</p>
    {/if}

    {#if counts}
      <p class="link-counts">
        {#each counts.split(' · ') as part, i (i)}{#if i > 0}{' · '}{/if}<span>{part}</span>{/each}
      </p>
    {/if}

    {#if sections?.highlights.length}
      <section class="link-section">
        <h2>Highlights</h2>
        <ul class="link-list">
          {#each sections.highlights as entry (entry.did)}
            <li class="link-item">
              <blockquote class="entry-quote"><p>{entry.quote}</p></blockquote>
              {#if entry.note}<p class="link-note">{entry.note}</p>{/if}
              {@render byline(entry, entry.verb || 'highlighted')}
            </li>
          {/each}
        </ul>
      </section>
    {/if}

    {#if sections?.discussion.length}
      <section class="link-section">
        <h2>Discussion</h2>
        <ul class="link-list">
          {#each sections.discussion as entry (`${entry.lane}:${entry.did}`)}
            <li class="link-item">
              {#if entry.note}<p class="link-note">{entry.note}</p>{/if}
              {@render byline(entry, entry.verb || LANE_VERBS[entry.lane] || 'wrote')}
            </li>
          {/each}
        </ul>
      </section>
    {/if}

    {#if sections?.saves.length}
      <section class="link-section">
        <h2>Saved in</h2>
        <ul class="link-list">
          {#each sections.saves as entry (entry.did)}
            <li class="link-item">
              {@render byline(entry, 'saved it on Semble')}
              {#if entry.collections.length}
                <p class="link-collections">
                  {#each entry.collections as collection, i (i)}
                    {#if i > 0}{' · '}{/if}
                    {#if safeHttpUrl(collection.url ?? undefined)}
                      <a href={safeHttpUrl(collection.url ?? undefined)} rel={OUTBOUND_REL}
                        >{collection.name}</a
                      >
                    {:else}{collection.name}{/if}
                  {/each}
                </p>
              {/if}
            </li>
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

{#snippet byline(entry: LinkEntry, verb: string)}
  {@const profile = profileUrl(entry)}
  {@const permalink = outbound(entry)}
  {@const date = entry.createdAt ? formatDate(entry.createdAt) : ''}
  <p class="link-byline">
    {#if profile}<a href={profile} rel={OUTBOUND_REL}>{personName(entry)}</a
      >{:else}{personName(entry)}{/if}
    {verb}
    {#if date}
      <span class="sep" aria-hidden="true">·</span>
      {#if permalink}<a href={permalink} rel={OUTBOUND_REL}>{date}</a>{:else}{date}{/if}
    {:else if permalink}
      <span class="sep" aria-hidden="true">·</span>
      <a href={permalink} rel={OUTBOUND_REL}>View</a>
    {/if}
  </p>
{/snippet}
