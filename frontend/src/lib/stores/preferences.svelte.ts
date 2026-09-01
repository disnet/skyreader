import { browser } from '$app/environment';
import { auth } from '$lib/stores/auth.svelte';
import {
  HIGHLIGHT_REVIEW_COUNT_DEFAULT,
  HIGHLIGHT_REVIEW_COUNT_OPTIONS,
  type HighlightReviewCount,
} from '$lib/utils/highlightReview';

export { HIGHLIGHT_REVIEW_COUNT_OPTIONS, type HighlightReviewCount };

export type ArticleFont = 'sans-serif' | 'serif' | 'mono' | 'literata';
// Reader body size, in CSS pixels. Was a fixed xs…xl scale (12–20px); now a
// wider numeric range so large-type reading is actually reachable. Legacy
// stored keys are migrated on load (see LEGACY_FONT_SIZE_PX).
export type ArticleFontSize = number;

export const ARTICLE_FONT_SIZE_MIN = 14;
export const ARTICLE_FONT_SIZE_MAX = 40;
export const ARTICLE_FONT_SIZE_STEP = 2;
export const ARTICLE_FONT_SIZE_DEFAULT = 18;

// Map the retired xs…xl keys onto their old px values so a returning user keeps
// roughly the size they had (clamped into the new range).
const LEGACY_FONT_SIZE_PX: Record<string, number> = {
  xs: 12,
  sm: 14,
  md: 16,
  lg: 18,
  xl: 20,
};

function clampFontSize(px: number): number {
  return Math.max(ARTICLE_FONT_SIZE_MIN, Math.min(ARTICLE_FONT_SIZE_MAX, Math.round(px)));
}

// Accept either a modern numeric px value or a legacy key; null if unusable.
function coerceFontSize(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return clampFontSize(value);
  if (typeof value === 'string' && value in LEGACY_FONT_SIZE_PX) {
    return clampFontSize(LEGACY_FONT_SIZE_PX[value]);
  }
  return null;
}
// How the full-screen readers lay out prose: a continuous vertical scroll, or a
// Kindle-style paged view (one page — or two columns when wide — turned at a time).
export type ReaderViewMode = 'scroll' | 'paged';
export type BaseSortOrder = 'newest' | 'oldest';
export type DailyMagazineMinutes = 10 | 20 | 30 | 45 | 60;
// How the daily magazine picks which saved articles to include.
export type DailyMagazineOrder = 'shuffle' | 'recent' | 'oldest';
// Which reading surface the app opens to on a fresh load (the `/` redirector).
export type DefaultView = 'home' | 'feeds' | 'saved';
// How tightly the Home lane tiles are packed (tile width, thumbnail, padding).
export type CardDensity = 'compact' | 'cozy' | 'comfortable';

export const DAILY_MAGAZINE_MINUTE_OPTIONS: DailyMagazineMinutes[] = [10, 20, 30, 45, 60];
export const DAILY_MAGAZINE_ORDER_OPTIONS: { value: DailyMagazineOrder; label: string }[] = [
  { value: 'shuffle', label: 'Random' },
  { value: 'recent', label: 'Most recent' },
  { value: 'oldest', label: 'Oldest' },
];

interface PreferencesState {
  articleFont: ArticleFont;
  articleFontSize: ArticleFontSize;
  readerViewMode: ReaderViewMode;
  scrollToMarkAsRead: boolean;
  expandAllItems: boolean;
  sortOrder: BaseSortOrder;
  // Accounts (by DID) that have acknowledged the first-share "this is public"
  // confirmation, and accounts whose linkblog is deleted. Both are per-account
  // facts living in a device-global blob that logout doesn't clear, so they're
  // keyed by DID: a second account on the same browser must not inherit the
  // first account's acknowledgment (it would publish publicly with no warning)
  // or its deleted linkblog.
  linkblogShareConfirmedDids: string[];
  linkblogDisabledDids: string[];
  // The "Posted from Skyreader" line: whether the composer OFFERS the checkbox
  // at all (the settings kill-switch — a feature that would be annoying if it
  // were always in the way), and whether the box is ticked by default. Both are
  // per-account for the same reason as the two lists above: a second account on
  // this browser must not inherit the first one's publishing habits. Client-side
  // only — the server acts on the per-request flag, so this is UI state, and the
  // tradeoff is that it doesn't follow you to another device.
  linkblogAttributionOfferedDids: string[];
  linkblogAttributionOnDids: string[];
  // Which surface a cold app load lands on (consumed by the `/` redirector).
  defaultView: DefaultView;
  // How tightly the Home lane tiles are packed.
  cardDensity: CardDensity;
  dailyMagazineMinutes: DailyMagazineMinutes;
  dailyMagazineOrder: DailyMagazineOrder;
  communityHighlights: boolean;
  // Distinguishes an explicit opt-out from the former default-off value that
  // was written whenever any preference was saved.
  communityHighlightsConfigured: boolean;
  // How many highlights one review session serves up.
  highlightReviewCount: HighlightReviewCount;
  // Pull the reader's own Margin highlights into Skyreader. Device-local: once
  // one device imports, the highlights sync everywhere as normal label rows.
  marginHighlightImport: boolean;
}

const STORAGE_KEY = 'skyreader-preferences';

// localStorage is user-editable and carries whatever an older build wrote, so a
// DID list is only trusted once it's actually a list of strings.
function didList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((did): did is string => typeof did === 'string') : [];
}

function createPreferencesStore() {
  let state = $state<PreferencesState>({
    articleFont: 'serif',
    articleFontSize: ARTICLE_FONT_SIZE_DEFAULT,
    readerViewMode: 'scroll',
    scrollToMarkAsRead: false,
    expandAllItems: true,
    sortOrder: 'newest',
    linkblogShareConfirmedDids: [],
    linkblogDisabledDids: [],
    linkblogAttributionOfferedDids: [],
    linkblogAttributionOnDids: [],
    defaultView: 'home',
    cardDensity: 'cozy',
    dailyMagazineMinutes: 20,
    dailyMagazineOrder: 'shuffle',
    communityHighlights: true,
    communityHighlightsConfigured: false,
    highlightReviewCount: HIGHLIGHT_REVIEW_COUNT_DEFAULT,
    marginHighlightImport: false,
  });

  // Restore from localStorage on init
  if (browser) {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
      try {
        const parsed = JSON.parse(stored);
        if (parsed.articleFont) {
          state.articleFont = parsed.articleFont;
        }
        const migratedSize = coerceFontSize(parsed.articleFontSize);
        if (migratedSize !== null) {
          state.articleFontSize = migratedSize;
        }
        if (parsed.readerViewMode === 'scroll' || parsed.readerViewMode === 'paged') {
          state.readerViewMode = parsed.readerViewMode;
        }
        if (parsed.scrollToMarkAsRead !== undefined) {
          state.scrollToMarkAsRead = parsed.scrollToMarkAsRead;
        }
        if (parsed.expandAllItems !== undefined) {
          state.expandAllItems = parsed.expandAllItems;
        }
        if (parsed.sortOrder) {
          state.sortOrder = parsed.sortOrder;
        }
        // Legacy device-global booleans are intentionally NOT migrated: they
        // can't be attributed to an account. The disabled flag re-derives from
        // the server on the next publication fetch, and an un-attributable
        // share acknowledgment falls back to showing the warning once more —
        // the safe direction for something that publishes publicly.
        state.linkblogShareConfirmedDids = didList(parsed.linkblogShareConfirmedDids);
        state.linkblogDisabledDids = didList(parsed.linkblogDisabledDids);
        state.linkblogAttributionOfferedDids = didList(parsed.linkblogAttributionOfferedDids);
        state.linkblogAttributionOnDids = didList(parsed.linkblogAttributionOnDids);
        if (
          parsed.defaultView === 'home' ||
          parsed.defaultView === 'feeds' ||
          parsed.defaultView === 'saved'
        ) {
          state.defaultView = parsed.defaultView;
        }
        if (
          parsed.cardDensity === 'compact' ||
          parsed.cardDensity === 'cozy' ||
          parsed.cardDensity === 'comfortable'
        ) {
          state.cardDensity = parsed.cardDensity;
        }
        if (DAILY_MAGAZINE_MINUTE_OPTIONS.includes(parsed.dailyMagazineMinutes)) {
          state.dailyMagazineMinutes = parsed.dailyMagazineMinutes;
        }
        if (DAILY_MAGAZINE_ORDER_OPTIONS.some((o) => o.value === parsed.dailyMagazineOrder)) {
          state.dailyMagazineOrder = parsed.dailyMagazineOrder;
        }
        if (
          parsed.communityHighlightsConfigured === true &&
          typeof parsed.communityHighlights === 'boolean'
        ) {
          state.communityHighlights = parsed.communityHighlights;
          state.communityHighlightsConfigured = true;
        }
        if (HIGHLIGHT_REVIEW_COUNT_OPTIONS.includes(parsed.highlightReviewCount)) {
          state.highlightReviewCount = parsed.highlightReviewCount;
        }
        if (typeof parsed.marginHighlightImport === 'boolean') {
          state.marginHighlightImport = parsed.marginHighlightImport;
        }
      } catch {
        localStorage.removeItem(STORAGE_KEY);
      }
    }
  }

  function save() {
    if (browser) {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    }
  }

  function setArticleFont(font: ArticleFont) {
    state.articleFont = font;
    save();
  }

  function setArticleFontSize(size: ArticleFontSize) {
    state.articleFontSize = clampFontSize(size);
    save();
  }

  function increaseFontSize() {
    const next = clampFontSize(state.articleFontSize + ARTICLE_FONT_SIZE_STEP);
    if (next !== state.articleFontSize) {
      state.articleFontSize = next;
      save();
    }
  }

  function decreaseFontSize() {
    const next = clampFontSize(state.articleFontSize - ARTICLE_FONT_SIZE_STEP);
    if (next !== state.articleFontSize) {
      state.articleFontSize = next;
      save();
    }
  }

  function resetFontSize() {
    state.articleFontSize = ARTICLE_FONT_SIZE_DEFAULT;
    save();
  }

  function setReaderViewMode(mode: ReaderViewMode) {
    state.readerViewMode = mode;
    save();
  }

  function toggleReaderViewMode() {
    state.readerViewMode = state.readerViewMode === 'paged' ? 'scroll' : 'paged';
    save();
  }

  function setScrollToMarkAsRead(enabled: boolean) {
    state.scrollToMarkAsRead = enabled;
    save();
  }

  function setExpandAllItems(enabled: boolean) {
    state.expandAllItems = enabled;
    save();
  }

  function setSortOrder(order: BaseSortOrder) {
    state.sortOrder = order;
    save();
  }

  function toggleSortOrder() {
    state.sortOrder = state.sortOrder === 'newest' ? 'oldest' : 'newest';
    save();
  }

  function confirmLinkblogShare() {
    const did = auth.user?.did;
    if (!did || state.linkblogShareConfirmedDids.includes(did)) return;
    state.linkblogShareConfirmedDids = [...state.linkblogShareConfirmedDids, did];
    save();
  }

  function setLinkblogDisabled(disabled: boolean) {
    const did = auth.user?.did;
    if (!did || disabled === state.linkblogDisabledDids.includes(did)) return;
    state.linkblogDisabledDids = disabled
      ? [...state.linkblogDisabledDids, did]
      : state.linkblogDisabledDids.filter((d) => d !== did);
    save();
  }

  // A per-account DID membership flag, the shape the four linkblog preferences
  // share: present in the list = on for this account, logged out = off.
  function setDidFlag(list: string[], on: boolean): string[] | null {
    const did = auth.user?.did;
    if (!did || on === list.includes(did)) return null;
    return on ? [...list, did] : list.filter((d) => d !== did);
  }

  /** Whether the composer offers the "Posted from Skyreader" checkbox at all. */
  function setLinkblogAttributionOffered(offered: boolean) {
    const next = setDidFlag(state.linkblogAttributionOfferedDids, offered);
    if (!next) return;
    state.linkblogAttributionOfferedDids = next;
    // Disabling is a kill-switch: also drop the sticky ticked state. Left in
    // place, it would seed the next draft's (now invisible) checkbox to true
    // and keep publishing the line. Re-enabling starts from an unticked box.
    if (!offered) {
      const on = setDidFlag(state.linkblogAttributionOnDids, false);
      if (on) state.linkblogAttributionOnDids = on;
    }
    save();
  }

  /** Whether that checkbox starts ticked — sticky across drafts, per account. */
  function setLinkblogAttributionOn(on: boolean) {
    const next = setDidFlag(state.linkblogAttributionOnDids, on);
    if (!next) return;
    state.linkblogAttributionOnDids = next;
    save();
  }

  function setDefaultView(view: DefaultView) {
    state.defaultView = view;
    save();
  }

  function setCardDensity(density: CardDensity) {
    state.cardDensity = density;
    save();
  }

  function setDailyMagazineMinutes(minutes: DailyMagazineMinutes) {
    if (!DAILY_MAGAZINE_MINUTE_OPTIONS.includes(minutes)) return;
    state.dailyMagazineMinutes = minutes;
    save();
  }

  function setDailyMagazineOrder(order: DailyMagazineOrder) {
    if (!DAILY_MAGAZINE_ORDER_OPTIONS.some((o) => o.value === order)) return;
    state.dailyMagazineOrder = order;
    save();
  }
  function setCommunityHighlights(enabled: boolean) {
    state.communityHighlights = enabled;
    state.communityHighlightsConfigured = true;
    save();
  }

  function setHighlightReviewCount(count: HighlightReviewCount) {
    if (!HIGHLIGHT_REVIEW_COUNT_OPTIONS.includes(count)) return;
    state.highlightReviewCount = count;
    save();
  }

  function setMarginHighlightImport(enabled: boolean) {
    state.marginHighlightImport = enabled;
    save();
  }

  return {
    get articleFont() {
      return state.articleFont;
    },
    get articleFontSize() {
      return state.articleFontSize;
    },
    get readerViewMode() {
      return state.readerViewMode;
    },
    get scrollToMarkAsRead() {
      return state.scrollToMarkAsRead;
    },
    get expandAllItems() {
      return state.expandAllItems;
    },
    get sortOrder() {
      return state.sortOrder;
    },
    // Both read the CURRENT account. Logged out, neither is true: no account
    // has acknowledged anything, and nothing should be hidden as deleted.
    get linkblogShareConfirmed() {
      const did = auth.user?.did;
      return !!did && state.linkblogShareConfirmedDids.includes(did);
    },
    get linkblogDisabled() {
      const did = auth.user?.did;
      return !!did && state.linkblogDisabledDids.includes(did);
    },
    // Default OFF: the checkbox is a feature you opt into, not one that greets
    // every draft. Turned on in Settings → Shared links.
    get linkblogAttributionOffered() {
      const did = auth.user?.did;
      return !!did && state.linkblogAttributionOfferedDids.includes(did);
    },
    // Gated on the offer, not just the ticked list: builds before the
    // kill-switch cleared the sticky value on disable may have persisted a
    // ticked state with the offer off, and that must never seed a draft.
    get linkblogAttributionOn() {
      const did = auth.user?.did;
      return (
        !!did &&
        state.linkblogAttributionOfferedDids.includes(did) &&
        state.linkblogAttributionOnDids.includes(did)
      );
    },
    get defaultView() {
      return state.defaultView;
    },
    get cardDensity() {
      return state.cardDensity;
    },
    get dailyMagazineMinutes() {
      return state.dailyMagazineMinutes;
    },
    get dailyMagazineOrder() {
      return state.dailyMagazineOrder;
    },
    get communityHighlights() {
      return state.communityHighlights;
    },
    get highlightReviewCount() {
      return state.highlightReviewCount;
    },
    get marginHighlightImport() {
      return state.marginHighlightImport;
    },
    setHighlightReviewCount,
    setMarginHighlightImport,
    confirmLinkblogShare,
    setLinkblogDisabled,
    setLinkblogAttributionOffered,
    setLinkblogAttributionOn,
    setDefaultView,
    setCardDensity,
    setDailyMagazineMinutes,
    setDailyMagazineOrder,
    setCommunityHighlights,
    setArticleFont,
    setArticleFontSize,
    increaseFontSize,
    decreaseFontSize,
    resetFontSize,
    setReaderViewMode,
    toggleReaderViewMode,
    setScrollToMarkAsRead,
    setExpandAllItems,
    setSortOrder,
    toggleSortOrder,
  };
}

export const preferences = createPreferencesStore();
