<script lang="ts">
  import {
    articleExcerpt,
    clampText,
    entryUrlFor,
    externalArticleUrl,
    formatDate,
    hostnameOf,
    linkPostNote,
    rkeyFromUri,
    socialCountsText,
  } from '$lib/fields';
  import type { ProxyDocument, SocialContext } from '$lib/types';
  import Meta from './Meta.svelte';

  interface Props {
    origin: string;
    did: string;
    doc: ProxyDocument;
    ctx?: SocialContext;
  }
  let { origin, did, doc, ctx = undefined }: Props = $props();

  const rkey = $derived(rkeyFromUri(doc.recordUri));
  const permalink = $derived(rkey ? entryUrlFor(origin, did, rkey) : null);

  // Two distinct things: the user's own note (their voice, plain text) and a
  // snippet quoted from the article (the article's voice). The excerpt is dropped
  // when it just repeats the note.
  const note = $derived(linkPostNote(doc).trim());
  const excerpt = $derived(articleExcerpt(doc));
  const host = $derived(hostnameOf(externalArticleUrl(doc) || doc.canonicalUrl));
  const date = $derived(formatDate(doc.createdAt || doc.publishedAt));
  const social = $derived(socialCountsText(ctx));
</script>

<li class="entry">
  <!-- The title anchor stretches over the whole row (its ::after covers the <li>),
       so the entire entry is one calm tap target to the permalink. -->
  <h2 class="entry-title">
    {#if permalink}
      <a href={permalink}>{doc.title || 'Untitled'}</a>
    {:else}
      {doc.title || 'Untitled'}
    {/if}
  </h2>
  {#if note}
    <p class="entry-note">{clampText(note, 280)}</p>
  {/if}
  {#if excerpt && excerpt !== note}
    <blockquote class="entry-quote"><p>{clampText(excerpt, 200)}</p></blockquote>
  {/if}
  <Meta {host} {date} {social} />
</li>
