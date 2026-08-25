import type {
  ArticleCardViewProps,
  DiscussionEntryVM,
  LaneId,
  LaneRowVM,
} from '$lib/components/articleCardView.types';
import { LANE_META } from '$lib/hooks/useAtmosphere.svelte';
import { cleanDiscussionNote } from '$lib/utils/discussionNote';
import { formatRelativeDate } from '$lib/utils/date';
import { renderLeafletContent } from '$lib/utils/leaflet-renderer';

/**
 * Mock view-models for ArticleCardView — one per visual state. These are plain
 * data (no stores, no network), so /dev/cards renders the card design with no
 * login and no backend. Add states here as you iterate on the card.
 */
export interface CardFixture {
  name: string;
  note: string;
  props: ArticleCardViewProps;
}

// ── Discussion fixture helpers ───────────────────────────────────────────────
// The panel renders pre-resolved view-models, so the harness builds them the
// same way useAtmosphere does: LANE_META folded in, the note cleaned against the
// article's title, the date pre-formatted. Keeping that here means the fixtures
// exercise the real derivation rather than a hand-written approximation.

const FIXTURE_TITLE = 'The Article Title';
// The publication's name, which the hosts pass alongside the headline — a bridge
// reprints either one, so the harness cleans against both.
const FIXTURE_SOURCE = 'The Publication Name';

/** An ISO timestamp N hours before the page rendered. */
export function hoursAgo(hours: number): string {
  return new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
}

export function laneVM(id: LaneId, over: Partial<LaneRowVM> = {}): LaneRowVM {
  const meta = LANE_META[id];
  const count = over.count ?? 0;
  const capped = over.capped ?? false;
  return {
    id,
    count,
    capped,
    canCreate: true,
    icon: meta.icon,
    label: meta.label,
    verb: meta.verb,
    title:
      count > 0
        ? `${count}${capped ? '+' : ''} ${meta.verb} this · ${meta.label}`
        : `${meta.label} — add yours`,
    isMine: false,
    createLabel: meta.createLabel,
    createIsEdit: false,
    ...over,
  };
}

export type StreamEntrySeed = Partial<DiscussionEntryVM> & Pick<DiscussionEntryVM, 'did'>;

export function splitStream(entries: DiscussionEntryVM[]): {
  entries: DiscussionEntryVM[];
  linkOnly: DiscussionEntryVM[];
} {
  const said: DiscussionEntryVM[] = [];
  const linkOnly: DiscussionEntryVM[] = [];
  // Mirrors useAtmosphere: one person, one name in the "Also linked by" line.
  const linkers = new Set<string>();
  for (const entry of entries) {
    const saidSomething = Boolean(entry.cleanNote || entry.quote || entry.collections?.length);
    if (saidSomething) {
      said.push(entry);
      continue;
    }
    const who = entry.did || entry.handle || entry.url || entry.key;
    if (linkers.has(who)) continue;
    linkers.add(who);
    linkOnly.push(entry);
  }
  return { entries: said, linkOnly };
}

export function streamEntry(lane: LaneId, seed: StreamEntrySeed): DiscussionEntryVM {
  const meta = LANE_META[lane];
  const createdAt = seed.createdAt ?? null;
  return {
    handle: null,
    displayName: null,
    avatar: null,
    note: null,
    url: null,
    collections: [],
    verb: null,
    quote: null,
    ...seed,
    createdAt,
    headVerb: seed.verb ?? (seed.collections?.length ? null : meta.verb),
    key: `${lane}|${seed.did}|${seed.url ?? ''}`,
    lane,
    laneLabel: meta.label,
    laneIcon: meta.icon,
    relativeTime: createdAt ? formatRelativeDate(createdAt) : null,
    isoTime: createdAt,
    cleanNote: cleanDiscussionNote(seed.note ?? null, [FIXTURE_TITLE, FIXTURE_SOURCE]),
  };
}

const FAVICON = 'https://icons.duckduckgo.com/ip3/arstechnica.com.ico';
const BLUESKY_FAVICON = 'https://icons.duckduckgo.com/ip3/bsky.app.ico';

const BODY_HTML = `
  <p>The owned library is a quiet idea: the things you read are yours, and the
  place you keep them is yours too. Not rented from a feed, not subject to a
  ranking change overnight.</p>
  <p>This is the second paragraph, here to give the body enough height to clamp
  when the card is selected but not expanded. It keeps going for a while so the
  fade-out gradient and the "More" affordance have something to act on.</p>
  <blockquote>A reader is a person who has decided, against the grain, to pay
  attention.</blockquote>
  <p>And a third paragraph to be safe, with a <a href="https://example.com">link</a>
  inside the prose so link-interception has a target when expanded.</p>
`;

// A body long enough to overflow the viewport, so the sticky action bar pins
// and earns its depth shadow while you scroll the page. The 'Expanded · long
// body' fixture uses it to exercise the overlapShadow action for real.
const BODY_HTML_LONG =
  BODY_HTML +
  Array.from(
    { length: 10 },
    (_, i) =>
      `<p>Paragraph ${i + 4}: more body copy to push the card past the fold. ` +
      `The action bar stays pinned to the bottom of the viewport with a depth ` +
      `shadow while this text scrolls beneath it, then settles flat once the ` +
      `card's end comes into view.</p>`
  ).join('\n');

// A Leaflet document whose footnotes are facets over a `*` marker — the shape a
// leaflet.pub post arrives in. Rendered here (not hand-written HTML) so the dev
// page exercises the real renderer: numbered references, the list at the end,
// and the click-to-jump wiring.
const LEAFLET_FOOTNOTES_HTML = renderLeafletContent(
  {
    $type: 'pub.leaflet.content',
    pages: [
      {
        $type: 'pub.leaflet.pages.linearDocument',
        blocks: [
          {
            block: {
              $type: 'pub.leaflet.blocks.text',
              plaintext:
                'Reading in public used to mean a blogroll and a feed reader.* The tools got quieter; the habit did not.',
              facets: [
                {
                  index: { byteStart: 60, byteEnd: 61 },
                  features: [
                    {
                      $type: 'pub.leaflet.richtext.facet#footnote',
                      footnoteId: 'fn-blogroll',
                      contentPlaintext:
                        'Both are still around, and both are better than they were. See the archive.',
                      contentFacets: [
                        {
                          index: { byteStart: 67, byteEnd: 74 },
                          features: [
                            {
                              $type: 'pub.leaflet.richtext.facet#link',
                              uri: 'https://example.com/archive',
                            },
                          ],
                        },
                      ],
                    },
                  ],
                },
              ],
            },
          },
          {
            block: {
              $type: 'pub.leaflet.blocks.text',
              plaintext:
                'What changed is where the record lives.* A reading life that outlives one app is worth the small friction of owning it.',
              facets: [
                {
                  index: { byteStart: 39, byteEnd: 40 },
                  features: [
                    {
                      $type: 'pub.leaflet.richtext.facet#footnote',
                      footnoteId: 'fn-record',
                      contentPlaintext:
                        'Portability is the foundation here, not the pitch — it only matters because it keeps the reading.',
                    },
                  ],
                },
              ],
            },
          },
        ],
      },
    ],
  },
  'did:plc:example'
);

const base: ArticleCardViewProps = {
  itemUrl: 'https://arstechnica.com/example-article',
  itemTitle: 'A calm, focused reader for the open social web',
  relativeDate: '2h ago',
  faviconUrl: FAVICON,
  displayFeedTitle: 'Ars Technica',
  feedTitle: 'Ars Technica',
  feedId: 12,
  readTimeMinutes: 0,
  sanitizedContent: '',
  hasContent: false,
  isDocumentMode: false,
  isLinkPostMode: false,
  itemTagCount: 0,
  itemTags: [],
  isOpen: false,
  // Signed in with a linkblog, so the action bar carries Share. On a card that
  // button IS the linkblog affordance — the discussion's compose row never
  // repeats it (see ArticleCard.laneCanCreate).
  canShare: true,
};

export const fixtures: CardFixture[] = [
  {
    name: 'Expanded · long body',
    note: 'Scroll the page: the action bar pins to the viewport bottom with a depth shadow, then settles flat at the card end. Exercises the overlapShadow action for real.',
    props: {
      ...base,
      expanded: true,
      isOpen: true,
      hasContent: true,
      readTimeMinutes: 7,
      sanitizedContent: BODY_HTML_LONG,
      hasOpenFullscreen: true,
    },
  },
  {
    name: 'Unread · collapsed',
    note: 'Default list row — only the sticky header shows.',
    props: { ...base, isRead: false },
  },
  {
    name: 'Short excerpt · fetch article',
    note: 'The feed gave only a short excerpt, so a quiet "Read full article" sits at the end of the body — it pulls the original via the feed proxy and swaps it inline. Hidden for full-content feeds.',
    props: {
      ...base,
      selected: true,
      expanded: true,
      isOpen: true,
      hasContent: true,
      readTimeMinutes: 1,
      sanitizedContent:
        '<p>The owned library is a quiet idea: the things you read are yours, and the place you keep them is yours too. Not rented from a feed, not subject to a ranking change overnight… <a href="https://arstechnica.com/example-article">Continue reading</a></p>',
      showFetchOriginal: true,
    },
  },
  {
    name: 'Long body · fetch in overflow menu',
    note: 'A full-content feed already gave us the whole article, so the prominent inline nudge is dropped — "Fetch full article" moves into the ⋯ overflow menu as a quiet way to force a clean re-extraction.',
    props: {
      ...base,
      selected: true,
      expanded: true,
      isOpen: true,
      hasContent: true,
      overflowMenuOpen: true,
      showFetchOriginalMenu: true,
    },
  },
  {
    name: 'Read · collapsed',
    note: 'Read items dim to 0.6 opacity.',
    props: { ...base, isRead: true },
  },
  {
    name: 'Selected · truncated',
    note: 'Body clamps with a fade; "More" is enabled.',
    props: {
      ...base,
      selected: true,
      isOpen: true,
      hasContent: true,
      isTruncated: true,
      readTimeMinutes: 4,
      sanitizedContent: BODY_HTML,
      hasOpenFullscreen: true,
    },
  },
  {
    name: 'Expanded · with content',
    note: 'Full body, sticky action bar, "Less".',
    props: {
      ...base,
      expanded: true,
      isOpen: true,
      hasContent: true,
      isTruncated: true,
      readTimeMinutes: 4,
      sanitizedContent: BODY_HTML,
      hasOpenFullscreen: true,
    },
  },
  {
    name: 'Expanded · atmosphere',
    note: 'Tap "Discussion" to open the panel: one chronological stream of everyone who wrote about this, whichever network they used, each entry wearing its source. The chips filter that stream; they are not four lists to click between. The bridge post that is nothing but the headline and two links keeps its person and its link, and loses its text.',
    props: {
      ...base,
      expanded: true,
      isOpen: true,
      hasContent: true,
      readTimeMinutes: 4,
      sanitizedContent: BODY_HTML,
      hasOpenFullscreen: true,
      laneRow: [
        {
          id: 'linkblog',
          count: 3,
          capped: false,
          // On a card the action bar's Share button is the linkblog affordance,
          // so the lane never offers its own (see ArticleCard.laneCanCreate).
          canCreate: false,
          icon: 'standard-site',
          label: 'Blogs',
          verb: 'noted',
          title: '3 noted this · Blogs',
          isMine: false,
          createLabel: 'Write a note',
          createIsEdit: false,
        },
        {
          id: 'bluesky',
          count: 12,
          capped: true,
          canCreate: true,
          icon: 'bluesky',
          label: 'Bluesky',
          verb: 'posted',
          title: '12+ posted this · Bluesky',
          isMine: false,
          createLabel: 'Post on Bluesky',
          createIsEdit: false,
        },
        {
          id: 'margin',
          count: 0,
          capped: false,
          canCreate: true,
          icon: 'margin',
          label: 'margin.at',
          verb: 'saved',
          title: 'margin.at — add yours',
          isMine: false,
          createLabel: 'Save to Margin',
          createIsEdit: false,
        },
        {
          id: 'semble',
          count: 0,
          capped: false,
          canCreate: true,
          icon: 'semble',
          label: 'Semble',
          verb: 'saved',
          title: 'Semble — add yours',
          isMine: false,
          createLabel: 'Save to Semble',
          createIsEdit: false,
        },
      ],
      filters: [
        { id: 'all', label: 'All', count: 15, capped: true, icon: null },
        { id: 'linkblog', label: 'Blogs', count: 3, capped: false, icon: 'standard-site' },
        { id: 'bluesky', label: 'Bluesky', count: 12, capped: true, icon: 'bluesky' },
      ],
      activeFilter: 'all',
      stream: {
        loading: false,
        ...splitStream([
          streamEntry('bluesky', {
            did: 'did:plc:alice',
            handle: 'alice.bsky.social',
            displayName: 'Alice Mbeki',
            avatar: null,
            createdAt: hoursAgo(3),
            note: 'Best take on this I have read all year. The second half is the part worth arguing with.',
            url: 'https://bsky.app/profile/alice.bsky.social/post/3kabc',
          }),
          streamEntry('linkblog', {
            did: 'did:plc:bob',
            handle: 'bob.example.com',
            displayName: 'Bob Iwu',
            avatar: null,
            createdAt: hoursAgo(19),
            note: 'Filed under things I will quote at someone this week.',
            url: 'https://bob.example.com/links/the-article',
          }),
          // A bridge post: the headline again, then two links. Nothing the reader
          // hasn't already got — cleanDiscussionNote empties it, and the entry
          // stands on its person, source, and link out.
          streamEntry('bluesky', {
            did: 'did:plc:hn',
            handle: 'betterhn20.e-work.xyz',
            displayName: null,
            avatar: null,
            createdAt: hoursAgo(26),
            note: 'The Article Title https://example.com/the-article (https://news.ycombinator.com/item?id=49396811)',
            url: 'https://bsky.app/profile/betterhn20.e-work.xyz/post/3kbot',
          }),
          streamEntry('bluesky', {
            did: 'did:plc:carol',
            handle: 'carol.test',
            displayName: 'Carol Nakamura',
            avatar: null,
            createdAt: null,
            note: 'Undated record — sorts last rather than pretending to be new.',
            url: 'https://bsky.app/profile/carol.test/post/3kold',
          }),
        ]),
      },
    },
  },
  {
    name: 'Discussion · resolving',
    note: 'The people are still coming back from their PDSes. The stream shows its own silhouette rather than a spinner, since the stream IS the content here.',
    props: {
      ...base,
      expanded: true,
      isOpen: true,
      hasContent: true,
      readTimeMinutes: 4,
      sanitizedContent: BODY_HTML,
      hasOpenFullscreen: true,
      laneRow: [
        laneVM('bluesky', { count: 12, capped: true }),
        laneVM('margin', { count: 2 }),
        laneVM('semble', { count: 0 }),
      ],
      // The counts are always-on, so the chips are already there while the
      // people are still resolving.
      filters: [
        { id: 'all', label: 'All', count: 14, capped: true, icon: null },
        { id: 'bluesky', label: 'Bluesky', count: 12, capped: true, icon: 'bluesky' },
        { id: 'margin', label: 'margin.at', count: 2, capped: false, icon: 'margin' },
      ],
      activeFilter: 'all',
      stream: { loading: true, entries: [] },
    },
  },
  {
    name: 'Discussion · nobody yet',
    note: 'No one has written about this article anywhere. The panel says so plainly and hands over the ways to be first — the empty state teaches the surface instead of showing four zeroes.',
    props: {
      ...base,
      expanded: true,
      isOpen: true,
      hasContent: true,
      readTimeMinutes: 4,
      sanitizedContent: BODY_HTML,
      hasOpenFullscreen: true,
      laneRow: [
        laneVM('linkblog', { count: 0 }),
        laneVM('bluesky', { count: 0 }),
        laneVM('margin', { count: 0 }),
        laneVM('semble', { count: 0 }),
      ],
      filters: [],
      activeFilter: 'all',
      stream: { loading: false, entries: [] },
    },
  },
  {
    name: 'Semble · saves',
    note: 'Semble saves aren\'t notes: the body says which collection the article was filed into, so the head drops the verb. A saver in several collections names each one; a saver with none reads "Saved this". Collection names link out to Semble.',
    props: {
      ...base,
      expanded: true,
      isOpen: true,
      hasContent: true,
      readTimeMinutes: 4,
      sanitizedContent: BODY_HTML,
      hasOpenFullscreen: true,
      laneRow: [
        {
          id: 'semble',
          count: 4,
          capped: false,
          canCreate: true,
          icon: 'semble',
          label: 'Semble',
          verb: 'saved',
          title: '4 saved this · Semble',
          isMine: false,
          createLabel: 'Save to Semble',
          createIsEdit: false,
        },
      ],
      filters: [],
      activeFilter: 'all',
      stream: {
        loading: false,
        ...splitStream([
          streamEntry('semble', {
            did: 'did:plc:alice',
            handle: 'alice.bsky.social',
            displayName: 'Alice Mbeki',
            avatar: null,
            createdAt: hoursAgo(5),
            url: 'https://semble.so/profile/alice.bsky.social',
            collections: [
              {
                name: 'AI & the open web',
                url: 'https://semble.so/profile/alice.bsky.social/collections/3kreadlist',
              },
            ],
          }),
          streamEntry('semble', {
            did: 'did:plc:bob',
            handle: 'bob.example.com',
            displayName: 'Bob Iwu',
            avatar: null,
            createdAt: hoursAgo(30),
            url: 'https://semble.so/profile/bob.example.com',
            collections: [
              {
                name: 'Reading queue',
                url: 'https://semble.so/profile/bob.example.com/collections/3kqueue',
              },
              {
                name: 'Protocol design',
                url: 'https://semble.so/profile/bob.example.com/collections/3kproto',
              },
            ],
          }),
          streamEntry('semble', {
            did: 'did:plc:carol',
            handle: 'carol.test',
            displayName: null,
            avatar: null,
            createdAt: hoursAgo(72),
            url: 'https://semble.so/profile/carol.test',
          }),
        ]),
      },
    },
  },
  {
    name: 'margin.at · annotations',
    note: "A margin.at annotation carries its own verb in the head (the note's W3C motivation), then the passage it points at, then the annotator's comment. The passage leads, because the passage is the point.",
    props: {
      ...base,
      expanded: true,
      isOpen: true,
      hasContent: true,
      readTimeMinutes: 4,
      sanitizedContent: BODY_HTML,
      hasOpenFullscreen: true,
      laneRow: [
        {
          id: 'margin',
          count: 3,
          capped: false,
          canCreate: true,
          icon: 'margin',
          label: 'margin.at',
          verb: 'saved',
          title: '3 saved this · margin.at',
          isMine: false,
          createLabel: 'Save to Margin',
          createIsEdit: false,
        },
      ],
      filters: [],
      activeFilter: 'all',
      stream: {
        loading: false,
        ...splitStream([
          streamEntry('margin', {
            did: 'did:plc:alice',
            handle: 'alice.bsky.social',
            displayName: 'Alice Mbeki',
            avatar: null,
            createdAt: hoursAgo(2),
            verb: 'highlighted',
            quote: 'the things you read are yours, and the place you keep them is yours too',
          }),
          streamEntry('margin', {
            did: 'did:plc:bob',
            handle: 'bob.example.com',
            displayName: 'Bob Iwu',
            avatar: null,
            createdAt: hoursAgo(21),
            verb: 'commented',
            note: 'Best framing of ownership I have seen in a while.',
          }),
          streamEntry('margin', {
            did: 'did:plc:carol',
            handle: 'carol.test',
            displayName: 'Carol Nakamura',
            avatar: null,
            createdAt: hoursAgo(50),
            verb: 'questioned',
            note: 'But what happens when the PDS goes offline?',
            quote: 'Not rented from a feed, not subject to a ranking change overnight.',
          }),
        ]),
      },
    },
  },
  {
    name: 'Shared · with a note',
    note: 'Once shared, the Share button carries it: it reads “Shared”, wears a dot when there is commentary behind it, and reopens the composer (where the note is edited and the share removed). The note itself is not reprinted under the article. The Discussion button tints to show one of the references is yours.',
    props: {
      ...base,
      expanded: true,
      isOpen: true,
      hasContent: true,
      readTimeMinutes: 4,
      sanitizedContent: BODY_HTML,
      hasOpenFullscreen: true,
      currentlyShared: true,
      currentNote: 'Sharing this for the framing in the second half.',
      // Once shared you appear in the Linkblogs lane (isMine), and the Discussion
      // button picks up the "mine" tint. The lane drops its [+] — the Share
      // button is the one way in.
      laneRow: [
        {
          id: 'linkblog',
          count: 4,
          capped: false,
          // Already shared: the lane drops its [+] (the Share button owns it).
          canCreate: false,
          icon: 'standard-site',
          label: 'Blogs',
          verb: 'noted',
          title: '4 noted this · Blogs',
          isMine: true,
          createLabel: 'Write a note',
          createIsEdit: false,
        },
        {
          id: 'bluesky',
          count: 6,
          capped: false,
          canCreate: true,
          icon: 'bluesky',
          label: 'Bluesky',
          verb: 'posted',
          title: '6 posted this · Bluesky',
          isMine: false,
          createLabel: 'Post on Bluesky',
          createIsEdit: false,
        },
      ],
    },
  },
  {
    name: 'Link post',
    note: 'A linkblog entry: byline + note as prose + external article card.',
    props: {
      ...base,
      itemTitle: 'The Web We Lost',
      isDocumentMode: true,
      isLinkPostMode: true,
      selected: true,
      isOpen: true,
      displayFeedTitle: 'anildash.com',
      feedTitle: undefined,
      authorDid: 'did:plc:carol',
      authorHandle: 'carol.bsky.social',
      authorDisplayName: 'Carol Reads',
      authorAvatar: BLUESKY_FAVICON,
      linkPostNote: 'Still the clearest essay on what we traded away for scale.',
      linkPostExcerpt:
        'The tools that we used to build the social web were open, and the data was ours. Here is what changed, and why it matters more than ever.',
      showActionBarIntegrations: true,
      hasSaveToSemble: true,
      hasSaveToMargin: true,
      // Link posts now carry the Atmosphere row too — keyed off the external
      // article's URL (how the linked piece travels the network).
      laneRow: [
        {
          id: 'linkblog',
          count: 4,
          capped: false,
          canCreate: true,
          icon: 'standard-site',
          label: 'Blogs',
          verb: 'noted',
          title: '4 noted this · Blogs',
          isMine: false,
          createLabel: 'Write a note',
          createIsEdit: false,
        },
        {
          id: 'bluesky',
          count: 8,
          capped: false,
          canCreate: true,
          icon: 'bluesky',
          label: 'Bluesky',
          verb: 'posted',
          title: '8 posted this · Bluesky',
          isMine: false,
          createLabel: 'Post on Bluesky',
          createIsEdit: false,
        },
        {
          id: 'margin',
          count: 0,
          capped: false,
          canCreate: true,
          icon: 'margin',
          label: 'margin.at',
          verb: 'saved',
          title: 'margin.at — add yours',
          isMine: false,
          createLabel: 'Save to Margin',
          createIsEdit: false,
        },
        {
          id: 'semble',
          count: 0,
          capped: false,
          canCreate: true,
          icon: 'semble',
          label: 'Semble',
          verb: 'saved',
          title: 'Semble — add yours',
          isMine: false,
          createLabel: 'Save to Semble',
          createIsEdit: false,
        },
      ],
      socialContext: { quoteCount: 2 },
    },
  },
  {
    name: 'Link post · in-note quote',
    note: 'The article quote is authored with Markdown markers, stored as a native Leaflet blockquote, and remains editable. No separate excerpt quote — the note owns the body.',
    props: {
      ...base,
      itemTitle: 'The Web We Lost',
      isDocumentMode: true,
      isLinkPostMode: true,
      selected: true,
      isOpen: true,
      displayFeedTitle: 'anildash.com',
      feedTitle: undefined,
      authorDid: 'did:plc:carol',
      authorHandle: 'carol.bsky.social',
      authorDisplayName: 'Carol Reads',
      authorAvatar: BLUESKY_FAVICON,
      // What marked() produces for: "Still the clearest essay on what we traded
      // away for scale.\n\n> The tools we used to build the social web were open,
      // and the data was ours."
      linkPostNoteHtml:
        '<p>Still the clearest essay on what we traded away for scale.</p>\n<blockquote>\n<p>The tools we used to build the social web were open, and the data was ours. Here is what changed, and why it matters more than ever.</p>\n</blockquote>',
      linkPostExcerpt: undefined,
      showActionBarIntegrations: true,
      hasSaveToSemble: true,
      hasSaveToMargin: true,
      laneRow: [],
    },
  },
  {
    name: 'Document',
    note: 'A published standard.site document. Fresh — no mentions yet, so only Bluesky anchors the panel ("Add yours"); the Discussion button still shows.',
    props: {
      ...base,
      itemTitle: 'Notes on building an owned library',
      isDocumentMode: true,
      isLinkPostMode: false,
      expanded: true,
      isOpen: true,
      hasContent: true,
      readTimeMinutes: 6,
      sanitizedContent: BODY_HTML,
      displayFeedTitle: 'standard.site',
      feedTitle: 'standard.site',
      authorDid: 'did:plc:frank',
      showActionBarIntegrations: true,
      hasSaveToSemble: true,
      hasSaveToMargin: true,
      hasOpenFullscreen: true,
      // No mentions yet: Bluesky always anchors the panel so the button is
      // present on every open card. Margin/Semble appear because the user has
      // those integrations wired (canCreate), offering "Add yours".
      laneRow: [
        {
          id: 'bluesky',
          count: 0,
          capped: false,
          canCreate: true,
          icon: 'bluesky',
          label: 'Bluesky',
          verb: 'posted',
          title: 'Bluesky — add yours',
          isMine: false,
          createLabel: 'Post on Bluesky',
          createIsEdit: false,
        },
        {
          id: 'margin',
          count: 0,
          capped: false,
          canCreate: true,
          icon: 'margin',
          label: 'margin.at',
          verb: 'saved',
          title: 'margin.at — add yours',
          isMine: false,
          createLabel: 'Save to Margin',
          createIsEdit: false,
        },
        {
          id: 'semble',
          count: 0,
          capped: false,
          canCreate: true,
          icon: 'semble',
          label: 'Semble',
          verb: 'saved',
          title: 'Semble — add yours',
          isMine: false,
          createLabel: 'Save to Semble',
          createIsEdit: false,
        },
      ],
    },
  },
  {
    name: 'Edition · collapsed',
    note: 'A curated edition (Collection) in the river. Reads as an ordinary list row — same favicon, title, meta, action bar — denoted only by the quiet "Edition · N" marker in the title row.',
    props: {
      ...base,
      itemTitle: 'Inflection points',
      isDocumentMode: true,
      displayFeedTitle: 'standard.site',
      feedTitle: 'standard.site',
      collectionPieceCount: 16,
    },
  },
  {
    name: 'Edition · open',
    note: 'Selected edition: the editorial intro, then each curated piece as a flat embedded card (curator note as a blockquote above it, with Save / Open in viewer / New tab actions). The same CollectionReader the fullscreen reader uses. "Open edition" replaces "Reader" in the action bar.',
    props: {
      ...base,
      itemTitle: 'Inflection points',
      isDocumentMode: true,
      selected: true,
      isOpen: true,
      expanded: true,
      displayFeedTitle: 'standard.site',
      feedTitle: 'standard.site',
      collectionPieceCount: 3,
      hasOpenFullscreen: true,
      onOpenCollectionPiece: () => {},
      onSaveCollectionPiece: () => {},
      isCollectionPieceSaved: (item) => item.document.endsWith('two'),
      collection: {
        publicationName: 'Dispatches from the Atmosphere',
        authorHandle: 'hipstersmoothie.com',
        // The real "Dispatches" basicTheme palette (light pink / dark purple /
        // magenta accent) so the magazine preview is faithful.
        theme: {
          accent: { r: 196, g: 33, b: 188 },
          background: { r: 255, g: 240, b: 254 },
          foreground: { r: 38, g: 4, b: 37 },
          accentForeground: { r: 255, g: 255, b: 255 },
        },
        // The publication's Google Fonts (app.standard-reader.publicationTheme).
        fonts: { title: 'Black Ops One', body: 'Space Grotesk' },
        editorial: {
          body: 'Every network has a season when the scaffolding comes down and you can finally see the shape of the thing being built. The pieces gathered here trace where the open social web turned a corner.',
        },
        colophon: { body: 'Curated in the open. Corrections welcome.' },
        items: [
          {
            document: 'at://did:plc:example/site.standard.document/one',
            note: 'The clearest account I have read of why **portability** changes the incentives, not just the plumbing.',
            title: 'The shape of a portable network',
            description:
              'When your data outlives the app, the app has to earn you back every day. That is the whole game.',
            canonicalUrl: 'https://blog.example.com/portable-network',
            sourceName: "Alex's Blog",
            publishedAt: '2026-05-02T00:00:00.000Z',
          },
          {
            document: 'at://did:plc:example/site.standard.document/two',
            note: 'Short, and worth it for the diagram alone.',
            title: 'Eurosky, one year in',
            description: 'A field report from the people shipping the infrastructure.',
            canonicalUrl: 'https://eurosky.example/one-year',
            sourceName: 'Modal Foundation',
            publishedAt: '2026-04-18T00:00:00.000Z',
          },
          {
            document: 'at://did:plc:example/site.standard.document/three',
            note: 'Could not resolve a preview for this one, but the note stands on its own.',
          },
        ],
      },
    },
  },
  {
    name: 'Leaflet · footnotes',
    note: 'A Leaflet post with footnote facets: each reference renders as a numbered superscript instead of a bare "*", and the bodies collect in a ruled list at the end. Tap a number to jump down, ↩ to come back.',
    props: {
      ...base,
      itemTitle: 'Notes on reading in public',
      displayFeedTitle: 'leaflet.pub',
      feedTitle: 'A Quiet Publication',
      isDocumentMode: true,
      selected: true,
      isOpen: true,
      expanded: true,
      hasContent: true,
      readTimeMinutes: 2,
      sanitizedContent: LEAFLET_FOOTNOTES_HTML,
      hasOpenFullscreen: true,
    },
  },
  {
    name: 'Tagged',
    note: 'Expanded item with tag chips.',
    props: {
      ...base,
      expanded: true,
      isOpen: true,
      hasContent: true,
      readTimeMinutes: 3,
      sanitizedContent: BODY_HTML,
      hasOpenFullscreen: true,
      itemTagCount: 2,
      itemTags: ['to-read', 'atproto'],
    },
  },
];
