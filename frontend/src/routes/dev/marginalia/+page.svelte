<script lang="ts">
  // Harness for the reader's marginalia: the real SavedReader over a seeded
  // article with a few highlights, notes and community (Margin) highlights
  // already on it. No auth, no backend (see ../+layout.ts): highlight writes go
  // to the local label store and queue, and the community fetch is stubbed.
  //
  // Wide desktop (≥1280px): notes in both margins. 1001–1279px: the column
  // slides left to keep the right margin; community notes shrink to brackets.
  // ≤1000px, or paged mode: notes unfold under their paragraph as a gloss.
  import { onMount } from 'svelte';
  import SavedReader from '$lib/components/feed/SavedReader.svelte';
  import { itemLabelsStore } from '$lib/stores/itemLabels.svelte';
  import { api } from '$lib/services/api';
  import type { FeedDisplayItem } from '$lib/stores/feedView.svelte';
  import type { CommunityHighlightNote, Highlight } from '$lib/types';

  const URL = 'https://example.com/essays/the-poverty-of-attention';
  const KEY = 'at://did:plc:devharness/app.skyreader.feed.saved/marginalia';

  const content = `
<p>The cost of attention is not paid in minutes. It is paid in what we stop noticing: the second reading, the footnote, the argument that only shows itself on the third page. A wealth of information creates a poverty of attention, and the poverty compounds.</p>
<p>Herbert Simon made the point in 1971, in a lecture about organizations rather than people. Information, he wrote, consumes the attention of its recipients. The more of it there is, the more carefully the recipient has to choose what to <em>not</em> look at, and the more that choice becomes the real work.</p>
<p>Readers have always had a tool for this, and it is not a feed. It is the margin. A pencil line beside a paragraph says <em>come back here</em>. A bracket says <em>this, and only this</em>. A note says what the reader thought at the time, which is often more interesting than what the author said.</p>
<p>Marginalia are a record of an argument with a book. Coleridge filled the margins of other people's books so thoroughly that his friends began lending him volumes on purpose, to get them back annotated. The note was the point; the book was the occasion.</p>
<p>Software has mostly flattened this into a yellow rectangle and a comment bubble. The rectangle is precise and joyless. The bubble floats over the very sentence it is about, so that to read your own note you have to hide the thing you were noting.</p>
<p>What would it take to get the margin back? Space, first: a column that leaves room beside the text rather than a text that fills the screen. Then a hand: marks that look made rather than applied, so that a page you have read looks like a page you have read.</p>
<p>And restraint. A margin crowded with apparatus is no better than a toolbar. The reader should be able to ignore every mark on the page and still read; the marks are there for when they want to remember, not to demand that they do.</p>
<p>The best annotated books are not the ones with the most notes. They are the ones where the notes and the text have become a single object, so that you cannot quite remember which idea was the author's and which was yours.</p>
`;

  const readerItem: FeedDisplayItem = {
    type: 'saved',
    key: KEY,
    item: {
      rkey: '',
      uri: KEY,
      url: URL,
      title: 'The Poverty of Attention',
      author: 'A. Reader',
      description: 'On margins, pencils, and what reading leaves behind.',
      content,
      contentType: 'text/html',
      domain: 'example.com',
      image: null,
      wordCount: 420,
      publishedAt: '2026-09-01T12:00:00Z',
      savedAt: '2026-09-20T12:00:00Z',
      source: 'url',
    },
  };

  const seed: Highlight[] = [
    {
      id: 'seed-poverty',
      selector: {
        type: 'TextQuoteSelector',
        exact: 'A wealth of information creates a poverty of attention, and the poverty compounds.',
      },
      createdAt: Date.now() - 86_400_000,
      note: "this is the whole argument, really. cf. Simon '71 and the café essay",
    },
    {
      id: 'seed-bare',
      selector: {
        type: 'TextQuoteSelector',
        exact: 'Information, he wrote, consumes the attention of its recipients.',
      },
      createdAt: Date.now() - 80_000_000,
    },
    {
      id: 'seed-margin',
      selector: {
        type: 'TextQuoteSelector',
        exact:
          'A pencil line beside a paragraph says come back here. A bracket says this, and only this.',
      },
      createdAt: Date.now() - 70_000_000,
      note: 'Bracket vs. underline as two different verbs. Worth stealing for the review deck: the kind of mark could say how you meant it.',
    },
    {
      id: 'seed-coleridge',
      selector: {
        type: 'TextQuoteSelector',
        exact: 'The note was the point; the book was the occasion.',
      },
      createdAt: Date.now() - 60_000_000,
      note: 'Lamb lent him books to get them back annotated! Find the source.',
      // Published: shows the globe rather than the lock.
      marginUri: 'at://did:plc:devharness/at.margin.note/3kdevharness00',
      marginRkey: '3kdevharness00',
    },
    {
      id: 'seed-bubble',
      selector: {
        type: 'TextQuoteSelector',
        exact: 'The rectangle is precise and joyless.',
      },
      createdAt: Date.now() - 50_000_000,
      note: 'ouch',
    },
  ];

  const communityNotes: CommunityHighlightNote[] = [
    {
      did: 'did:plc:alice',
      handle: 'alice.bsky.social',
      displayName: 'Alice Chen',
      avatar: null,
      createdAt: '2026-09-10T12:00:00Z',
      motivation: 'commenting',
      note: 'Simon is always the right citation here.',
      selector: {
        type: 'TextQuoteSelector',
        exact: 'Herbert Simon made the point in 1971',
      },
    },
    {
      did: 'did:plc:bo',
      handle: 'bo.example.net',
      displayName: null,
      avatar: null,
      createdAt: '2026-09-11T12:00:00Z',
      motivation: 'highlighting',
      note: null,
      selector: {
        type: 'TextQuoteSelector',
        exact: 'What would it take to get the margin back?',
      },
    },
    {
      did: 'did:plc:cy',
      handle: 'cy.bsky.social',
      displayName: 'Cy',
      avatar: null,
      createdAt: '2026-09-12T12:00:00Z',
      motivation: 'commenting',
      note: 'This is what I want from every reading app and never get.',
      selector: {
        type: 'TextQuoteSelector',
        exact: 'marks that look made rather than applied',
      },
    },
  ];

  // The community fetch goes to the backend; answer it locally instead.
  api.fetchGuestCommunityHighlights = async () => ({ notes: communityNotes, capped: false });
  api.fetchCommunityHighlights = async () => ({ notes: communityNotes, capped: false });

  let ready = $state(false);
  let open = $state(true);

  onMount(() => {
    const existing = new Set(itemLabelsStore.getHighlights(KEY).map((h) => h.id));
    for (const h of seed) {
      if (!existing.has(h.id)) itemLabelsStore.addHighlight(KEY, 'saved', { ...h });
    }
    ready = true;
  });

  function reset() {
    for (const h of itemLabelsStore.getHighlights(KEY)) itemLabelsStore.removeHighlight(KEY, h.id);
    for (const h of seed) itemLabelsStore.addHighlight(KEY, 'saved', { ...h });
    open = false;
    setTimeout(() => (open = true), 0);
  }
</script>

{#if ready && open}
  <SavedReader {readerItem} onClose={() => (open = false)} />
{:else}
  <div class="closed">
    <button onclick={() => (open = true)}>Open the reader</button>
    <button onclick={reset}>Reset highlights</button>
    <a href="/dev">← Harnesses</a>
  </div>
{/if}

<style>
  .closed {
    display: flex;
    gap: 1rem;
    align-items: center;
    padding: 2rem;
    font-family: var(--font-sans-serif);
  }
</style>
