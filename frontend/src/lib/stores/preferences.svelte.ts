import { browser } from '$app/environment';

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
  // Set once the user has acknowledged the first-share "this is public" confirmation.
  linkblogShareConfirmed: boolean;
  // Which surface a cold app load lands on (consumed by the `/` redirector).
  defaultView: DefaultView;
  // How tightly the Home lane tiles are packed.
  cardDensity: CardDensity;
  dailyMagazineMinutes: DailyMagazineMinutes;
  dailyMagazineOrder: DailyMagazineOrder;
}

const STORAGE_KEY = 'skyreader-preferences';

function createPreferencesStore() {
  let state = $state<PreferencesState>({
    articleFont: 'serif',
    articleFontSize: ARTICLE_FONT_SIZE_DEFAULT,
    readerViewMode: 'scroll',
    scrollToMarkAsRead: false,
    expandAllItems: true,
    sortOrder: 'newest',
    linkblogShareConfirmed: false,
    defaultView: 'home',
    cardDensity: 'cozy',
    dailyMagazineMinutes: 20,
    dailyMagazineOrder: 'shuffle',
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
        if (parsed.linkblogShareConfirmed !== undefined) {
          state.linkblogShareConfirmed = parsed.linkblogShareConfirmed;
        }
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
    state.linkblogShareConfirmed = true;
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
    get linkblogShareConfirmed() {
      return state.linkblogShareConfirmed;
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
    confirmLinkblogShare,
    setDefaultView,
    setCardDensity,
    setDailyMagazineMinutes,
    setDailyMagazineOrder,
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
