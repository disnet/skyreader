import type {
  ArticleCardViewProps,
  DiscussionEntryVM,
  DiscussionFilterVM,
  LaneId,
  LaneRowVM,
} from '$lib/components/articleCardView.types';
import { LANE_META } from '$lib/constants/laneMeta';

/**
 * Sample content for the landing page's app showcase. Every source, article and
 * person here is made up; the page labels the showcase as sample content.
 *
 * The showcase renders the app's own presentational components (ArticleCardView,
 * AtmospherePanel, HighlightPopover), so this is plain view-model data in their
 * shapes, with no stores and no network, the same way /dev/cards feeds them.
 */

/** A monogram favicon, inline, so the landing page fetches nothing third-party. */
function monogram(letter: string, bg: string, fg = '#ffffff'): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="7" fill="${bg}"/><text x="16" y="22" font-family="system-ui,sans-serif" font-size="18" font-weight="700" text-anchor="middle" fill="${fg}">${letter}</text></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

export interface ShowcaseSource {
  title: string;
  favicon: string;
  /** What kind of source it is, in the sidebar's words. */
  kind: string;
  unread: number;
}

export const sources: ShowcaseSource[] = [
  { title: 'The Commonplace', favicon: monogram('C', '#2f6f5e'), kind: 'Blog', unread: 4 },
  {
    title: 'The Slow Web Review',
    favicon: monogram('S', '#8a4b2a'),
    kind: 'Newsletter',
    unread: 2,
  },
  { title: 'Library Futures', favicon: monogram('▶', '#c4302b'), kind: 'YouTube', unread: 1 },
  { title: 'Bluesky bookmarks', favicon: monogram('B', '#1185fe'), kind: 'Bluesky', unread: 3 },
  { title: 'Margins & Footnotes', favicon: monogram('M', '#5b4a9e'), kind: 'Leaflet', unread: 2 },
];

const byTitle = (title: string) => sources.find((s) => s.title === title)!;

const base: Omit<ArticleCardViewProps, 'itemUrl' | 'itemTitle' | 'faviconUrl'> = {
  relativeDate: '1h ago',
  readTimeMinutes: 3,
  sanitizedContent: '',
  hasContent: true,
  isDocumentMode: false,
  isLinkPostMode: false,
  itemTagCount: 0,
  itemTags: [],
  // The "Expand" view: each row shows its opening lines, clamped, with its
  // action bar.
  isOpen: true,
  isTruncated: true,
  canExpand: true,
  hasOpenFullscreen: true,
  canShare: true,
};

function card(
  source: string,
  over: Partial<ArticleCardViewProps> & Pick<ArticleCardViewProps, 'itemTitle'>
): ArticleCardViewProps {
  const s = byTitle(source);
  return {
    ...base,
    itemUrl: `https://example.com/${over.itemTitle.toLowerCase().replace(/\W+/g, '-')}`,
    faviconUrl: s.favicon,
    displayFeedTitle: s.title,
    feedTitle: s.title,
    ...over,
  };
}

/** The piece that arrives while you watch, from a newsletter. */
export const arrivingCard = card('The Slow Web Review', {
  itemTitle: 'What we lose when we skim',
  relativeDate: 'just now',
  readTimeMinutes: 6,
  sanitizedContent:
    '<p>Skimming optimizes for coverage. Understanding optimizes for collisions between ideas, and collisions take time. This week: three habits for reading fewer things, better.</p>',
});

/** The piece the tour opens and reads. */
export const featuredCard = card('The Commonplace', {
  itemTitle: 'Annotation is thinking',
  relativeDate: '1h ago',
  readTimeMinutes: 4,
  sanitizedContent:
    '<p>Annotation is usually described as something a reader adds to a text, the way a frame is added to a painting. That gets the direction wrong. A note in the margin is not decoration on top of reading; it is the visible part of the reading itself.</p><p>Watch someone read with a pen and you can see the difference.</p>',
});

export const timelineCards: ArticleCardViewProps[] = [
  featuredCard,
  card('Library Futures', {
    itemTitle: 'How a library decides what to keep',
    relativeDate: '3h ago',
    readTimeMinutes: 12,
    sanitizedContent:
      '<p>A walk through the stacks with the people who decide what stays, what goes, and what gets copied before it disappears.</p>',
  }),
  card('Margins & Footnotes', {
    itemTitle: 'A field guide to personal libraries',
    relativeDate: '5h ago',
    readTimeMinutes: 5,
    sanitizedContent:
      '<p>What a shelf arranged by memory can do that a database cannot, and where the database quietly wins.</p>',
  }),
];

/** The article as it opens in the reader. `passage` is the sentence the tour marks. */
export const article = {
  title: 'Annotation is thinking',
  source: 'The Commonplace',
  favicon: byTitle('The Commonplace').favicon,
  author: 'Ana Reyes',
  readTime: '4 min read',
  before:
    'Annotation is usually described as something a reader adds to a text, the way a frame is added to a painting. That gets the direction wrong. A note in the margin is not decoration on top of reading; it is the visible part of the reading itself.',
  passageLead: 'Watch someone read with a pen and you can see the difference. ',
  passage:
    'Every mark is a small decision about what matters, and the decisions are the understanding.',
  passageTail:
    ' Take the pen away and the decisions still happen, but nothing holds them still long enough to be examined.',
  after:
    'This is why rereading your own marginalia is so strange. You are not reviewing the book; you are reviewing a previous self in conversation with it.',
  note: 'the decisions are the understanding. keep the pen.',
};

// ── Discussion ───────────────────────────────────────────────────────────────

function lane(id: LaneId, count: number): LaneRowVM {
  const meta = LANE_META[id];
  return {
    id,
    count,
    capped: false,
    canCreate: false,
    icon: meta.icon,
    label: meta.label,
    verb: meta.verb,
    title: `${count} ${meta.verb} this · ${meta.label}`,
    isMine: false,
    createLabel: meta.createLabel,
    createIsEdit: false,
  };
}

function entry(
  laneId: LaneId,
  person: { did: string; handle: string; displayName: string },
  over: Partial<DiscussionEntryVM> & { relativeTime: string }
): DiscussionEntryVM {
  const meta = LANE_META[laneId];
  return {
    ...person,
    avatar: null,
    createdAt: null,
    note: null,
    url: null,
    collections: [],
    verb: null,
    quote: null,
    likeCount: null,
    isoTime: null,
    cleanNote: over.note ?? null,
    key: `${laneId}|${person.did}`,
    lane: laneId,
    laneLabel: meta.label,
    laneIcon: meta.icon,
    headVerb: over.verb ?? (over.collections?.length ? null : meta.verb),
    ...over,
  };
}

export const discussionLanes: LaneRowVM[] = [
  lane('bluesky', 6),
  lane('linkblog', 2),
  lane('semble', 3),
];

export const discussionFilters: DiscussionFilterVM[] = [
  {
    id: 'all',
    label: 'All',
    count: discussionLanes.reduce((n, l) => n + l.count, 0),
    capped: false,
    icon: null,
  },
  ...discussionLanes.map((l) => ({
    id: l.id,
    label: l.label,
    count: l.count,
    capped: false,
    icon: l.icon,
  })),
];

export const discussionEntries: DiscussionEntryVM[] = [
  entry(
    'bluesky',
    { did: 'did:example:mara', handle: 'mara.example', displayName: 'Mara Lind' },
    {
      relativeTime: '2h',
      likeCount: 48,
      note: 'The line about the decisions being the understanding is going on a sticky note above my desk.',
    }
  ),
  entry(
    'linkblog',
    { did: 'did:example:rui', handle: 'rui.example', displayName: 'Rui Costa' },
    {
      relativeTime: '5h',
      note: 'Pairs well with last month’s piece on rereading. Same argument, from the other side.',
    }
  ),
  entry(
    'semble',
    { did: 'did:example:ines', handle: 'ines.example', displayName: 'Inês Duarte' },
    {
      relativeTime: '1d',
      collections: [
        { name: 'How we read', url: null },
        { name: 'Marginalia', url: null },
      ],
    }
  ),
];
