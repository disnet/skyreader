import type { ArticleCardViewProps } from '$lib/components/articleCardView.types';

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
    note: 'Tap "Discussion" to open the panel: lanes are a tab strip, each chip fused to its own [+] create. The Blogs [+] shares to your linkblog (no-note share is the default); sharing then reveals the "Add your note…" box. Picking a tab reveals that lane\'s posts below.',
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
          canCreate: true,
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
      expandedLane: 'linkblog',
      expandedLaneItems: {
        loading: false,
        entries: [
          {
            did: 'did:plc:alice',
            handle: 'alice.bsky.social',
            note: 'Best take on this I have read all year.',
            url: 'https://example.com/alice',
          },
          {
            did: 'did:plc:bob',
            handle: 'bob.example.com',
            note: null,
            url: 'https://example.com/bob',
          },
        ],
      },
    },
  },
  {
    name: 'Shared · note box',
    note: 'Once shared, your note persists below the card (open or not). The box owns Edit (focus it) and Remove (unshare). The Discussion button tints to show one of the references is yours.',
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
      onRemoveShare: () => {},
      // Once shared you appear in the Linkblogs lane (isMine), and the Discussion
      // button picks up the "mine" tint. The panel drops its composer in this
      // state — your note lives in the persistent box above.
      laneRow: [
        {
          id: 'linkblog',
          count: 4,
          capped: false,
          // Already shared: the lane drops its [+] (the note box owns editing).
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
      alsoLinkedBy: [
        {
          recordUri: 'at://did:plc:dave/x/1',
          did: 'did:plc:dave',
          handle: 'dave.bsky.social',
          note: 'A classic.',
        },
        {
          recordUri: 'at://did:plc:erin/x/2',
          did: 'did:plc:erin',
          handle: 'erin.example.com',
          note: null,
        },
      ],
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
