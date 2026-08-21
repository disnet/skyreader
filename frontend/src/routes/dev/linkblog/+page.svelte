<script lang="ts">
  // Harness for the linkblog surface — the masthead and every entry state, in
  // the 800px column the real page uses. No auth, no backend (see ../+layout.ts);
  // a stub user is set so the ownership gate on Edit/Delete resolves the way it
  // does for a signed-in reader.
  //
  // ShareComposer is mounted here the way AppShell mounts it in the real app, so
  // Edit actually opens the drawer and the handoff is exercisable.
  //
  // What this harness can't fake: the publication lookup, so the masthead's
  // address row and the menu's "Copy post link" are absent here but present in
  // the real page. Posting and updating hit the API and will fail here. And the
  // drafts below are fabricated rather than saved, so Edit opens the composer
  // EMPTY — it restores blocks from the shareDrafts store by article URL, and in
  // the real page every draft in the stream came from that store to begin with.
  import { onMount } from 'svelte';
  import LinkblogEntry from '$lib/components/feed/LinkblogEntry.svelte';
  import LinkblogIntro from '$lib/components/feed/LinkblogIntro.svelte';
  import ShareComposer from '$lib/components/feed/ShareComposer.svelte';
  import { auth } from '$lib/stores/auth.svelte';
  import { LINKBLOG_MARKER_URL } from '$lib/utils/linkPost';
  import type { ShareDraft, SocialDocument } from '$lib/types';
  import Showcase from '../_harness/Showcase.svelte';
  import Case from '../_harness/Case.svelte';

  const DID = 'did:plc:harness';

  onMount(() => {
    auth.setUser({
      did: DID,
      handle: 'reader.example.com',
      displayName: 'Harness Reader',
      pdsUrl: 'https://pds.example.com',
    });
  });

  // A note is authored in the tiny Markdown subset the write path speaks: a
  // leading '> ' marks a quote, everything else is prose.
  function leafletNote(note: string) {
    const blocks = note.split('\n\n').map((chunk) =>
      chunk.startsWith('> ')
        ? {
            block: {
              $type: 'pub.leaflet.blocks.blockquote',
              plaintext: chunk.replace(/^> /gm, ''),
            },
          }
        : { block: { $type: 'pub.leaflet.blocks.text', plaintext: chunk } }
    );
    return {
      $type: 'pub.leaflet.content',
      pages: [{ $type: 'pub.leaflet.pages.linearDocument', blocks }],
    };
  }

  function post(
    rkey: string,
    title: string,
    url: string,
    note: string,
    daysAgo: number,
    opts: { foreign?: boolean } = {}
  ): SocialDocument {
    const at = new Date(Date.now() - daysAgo * 86400000).toISOString();
    return {
      authorDid: DID,
      recordUri: `at://${DID}/site.standard.document/${rkey}`,
      siteUri: opts.foreign
        ? `at://${DID}/site.standard.publication/essays`
        : `at://${DID}/site.standard.publication/skyreader-links`,
      title,
      publishedAt: at,
      createdAt: at,
      links: [{ uri: url, rel: 'related' }],
      content: note ? leafletNote(note) : undefined,
      ...(opts.foreign ? {} : { skyreaderLinkblog: LINKBLOG_MARKER_URL }),
    } as SocialDocument;
  }

  const withQuote = post(
    '3lharnessa',
    'The fastest query is the one you never run',
    'https://danluu.com/query-plans/',
    'The part that stuck with me is that the plan is a story the optimizer tells itself, ' +
      'and the story is usually wrong in the same three ways.\n\n' +
      '> A query plan is not a description of what the database will do. It is a description of what the database currently believes.\n\nWorth reading next to anything on capacity planning.',
    2
  );

  const shortNote = post(
    '3lharnessb',
    'On typographic scale',
    'https://example.com/typographic-scale',
    'Short, and right about the 1.125 ratio.',
    9
  );

  const noNote = post(
    '3lharnessc',
    'A field guide to margin notes',
    'https://example.com/margin-notes',
    '',
    41
  );

  const foreign = post(
    '3lharnessd',
    'An essay my other app published here',
    'https://example.com/essay',
    'This one lives in a connected publication Skyreader did not write, so it lists but ' +
      'offers no Edit or Delete.',
    120,
    { foreign: true }
  );

  const longNote = post(
    '3lharnesse',
    'Everything you wanted to know about column pagination',
    'https://example.com/pagination',
    'Three things I keep coming back to.\n\n' +
      '> Pagination is not scrolling with extra steps. It is a different contract with the reader: the page promises that what you can see is all there is right now.\n\n' +
      'The second is that the hard part is never the columns, it is the font metrics. ' +
      'The third is that every implementation eventually grows a resize observer and then ' +
      'grows a bug in it.\n\n' +
      '> The reflow you do not do is the reflow you do not have to debug.\n\n' +
      'Filed under: things I will reread when I inevitably build this again.',
    3
  );

  function draft(url: string, title: string, note: string, hoursAgo: number): ShareDraft {
    return {
      articleUrl: url,
      articleTitle: title,
      blocks: note
        .split('\n\n')
        .map((chunk) =>
          chunk.startsWith('> ')
            ? { kind: 'quote' as const, text: chunk.slice(2) }
            : { kind: 'text' as const, text: chunk }
        ),
      createdAt: Date.now() - hoursAgo * 3600000,
      updatedAt: Date.now() - hoursAgo * 3600000,
    };
  }

  const draftWithQuote = draft(
    'https://example.com/caching',
    'Caching is a distributed systems problem',
    'Not sure about the middle section yet, but the argument about invalidation is right.\n\n' +
      '> There are only two hard things, and both of them are naming.',
    2
  );

  const draftBare = draft(
    'https://example.com/half-written',
    'A piece I started writing about and stopped',
    'Half a thought',
    30
  );
</script>

<Showcase
  title="Linkblog"
  description="Your own linkblog: the masthead and every entry state, in the 800px reading column. Edit on any entry hands off to the ShareComposer drawer at the bottom of the screen."
>
  <Case
    name="LinkblogIntro"
    note="Masthead. No publication in the harness, so the address row is absent."
    width="800px"
  >
    <LinkblogIntro />
  </Case>

  <Case
    name="LinkblogEntry — published, with a quote"
    note="Headline, dateline and source, then your prose in the article face under the gold quotation rule."
    width="800px"
  >
    <LinkblogEntry doc={withQuote} />
  </Case>

  <Case name="LinkblogEntry — published, one line" width="800px">
    <LinkblogEntry doc={shortNote} />
  </Case>

  <Case
    name="LinkblogEntry — published, no commentary"
    note="A bare share. The absence is stated rather than left blank."
    width="800px"
  >
    <LinkblogEntry doc={noNote} />
  </Case>

  <Case
    name="LinkblogEntry — long, two quotes"
    note="Dateline falls back to a calendar date past a week."
    width="800px"
  >
    <LinkblogEntry doc={longNote} />
  </Case>

  <Case
    name="LinkblogEntry — foreign publication"
    note="Skyreader didn't write it, so there is no Edit control and no Delete in the menu."
    width="800px"
  >
    <LinkblogEntry doc={foreign} />
  </Case>

  <Case
    name="LinkblogEntry — draft"
    note="Not on the page yet, so it rests on the Sunken layer. Edit reopens it in the composer as the draft it is."
    width="800px"
  >
    <LinkblogEntry draft={draftWithQuote} />
  </Case>

  <Case name="LinkblogEntry — draft, barely started" width="800px">
    <LinkblogEntry draft={draftBare} />
  </Case>

  <Case
    name="Stream"
    note="How drafts and published entries read together in one chronological column."
    width="800px"
  >
    <div class="stream">
      <LinkblogEntry draft={draftWithQuote} />
      <LinkblogEntry doc={withQuote} />
      <LinkblogEntry doc={longNote} />
      <LinkblogEntry draft={draftBare} />
      <LinkblogEntry doc={noNote} />
    </div>
  </Case>
</Showcase>

<!-- Mounted once, as AppShell does, so an entry's Edit has a drawer to open. -->
<ShareComposer />

<style>
  .stream {
    display: flex;
    flex-direction: column;
  }
</style>
