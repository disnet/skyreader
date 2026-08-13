// Catalog of dev-only component harnesses. Drives the /dev index page so a human
// or agent can find every isolated-component canvas in one place. Add an entry
// here whenever you add a /dev/<slug>/ route.
//
// This file is colocated under src/routes/dev/ but is NOT a route — SvelteKit
// only generates routes from +page/+layout files, so the leading-underscore
// _harness/ directory just holds shared harness code.

export interface HarnessEntry {
  /** Route segment under /dev (e.g. 'cards' → /dev/cards). */
  slug: string;
  /** Display title for the catalog card. */
  title: string;
  /** One-line description of what the route exercises. */
  description: string;
  /** Component names rendered by the route, shown as chips on the catalog. */
  components: string[];
}

export const harnesses: HarnessEntry[] = [
  {
    slug: 'cards',
    title: 'Article cards',
    description:
      'ArticleCardView across every reading state — collapsed, expanded, link posts, documents, and the Atmosphere discussion lanes.',
    components: ['ArticleCardView'],
  },
  {
    slug: 'primitives',
    title: 'Primitives',
    description:
      'Low-level building blocks: the icon set, tooltips, popover menus, loading/empty states, and inputs.',
    components: [
      'Icon',
      'Tooltip',
      'PopoverMenu',
      'LoadingState',
      'EmptyState',
      'DomainPatternInput',
      'PullToRefresh',
    ],
  },
  {
    slug: 'common',
    title: 'Common shells',
    description:
      'Reusable container shells: modals, bottom sheets, the load/empty/content state switch, infinite-scroll sentinel, and the user card.',
    components: ['Modal', 'BottomSheet', 'StateView', 'InfiniteScrollSentinel', 'UserCard'],
  },
  {
    slug: 'sources',
    title: 'Sources',
    description:
      'The feed-management surface: toolbar, section + group headers, source rows in every state, and the bulk-action bar.',
    components: [
      'SourcesToolbar',
      'SourceSectionHeader',
      'SourceGroupHeader',
      'SourceRow',
      'BulkActionBar',
    ],
  },
  {
    slug: 'sidebar',
    title: 'Sidebar',
    description:
      'Sidebar chrome: collapsible nav sections, view/channel rows, the right-click context menu, and the resize handle.',
    components: ['NavSection', 'ViewItem', 'ContextMenu', 'ResizeHandle'],
  },
  {
    slug: 'reader',
    title: 'Mobile bottom chrome',
    description:
      'Both bottom bars over a scrolling surface — the reader’s (progress rail, detached hairline, style sheet) and the app’s (view switcher + actions). Mobile widths only.',
    components: ['ReaderBottomBar', 'MobileBottomBar', 'ReadingModeToggle', 'BottomSheet'],
  },
  {
    slug: 'feed',
    title: 'Feed surfaces',
    description:
      'Presentational feed pieces: filter popover, highlight popover, share-note box, and the welcome screen.',
    components: ['FilterPopover', 'HighlightPopover', 'ShareCommentBox', 'WelcomePage'],
  },
];
