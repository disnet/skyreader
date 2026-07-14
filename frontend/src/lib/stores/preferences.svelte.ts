import { browser } from '$app/environment';

export type ArticleFont = 'sans-serif' | 'serif' | 'mono' | 'literata';
export type ArticleFontSize = 'xs' | 'sm' | 'md' | 'lg' | 'xl';
// How the full-screen readers lay out prose: a continuous vertical scroll, or a
// Kindle-style paged view (one page — or two columns when wide — turned at a time).
export type ReaderViewMode = 'scroll' | 'paged';
export type BaseSortOrder = 'newest' | 'oldest';
export type DailyMagazineMinutes = 10 | 20 | 30 | 45 | 60;
// Which reading surface the app opens to on a fresh load (the `/` redirector).
export type DefaultView = 'home' | 'feeds' | 'saved';

const FONT_SIZE_ORDER: ArticleFontSize[] = ['xs', 'sm', 'md', 'lg', 'xl'];
export const DAILY_MAGAZINE_MINUTE_OPTIONS: DailyMagazineMinutes[] = [10, 20, 30, 45, 60];

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
  dailyMagazineMinutes: DailyMagazineMinutes;
}

const STORAGE_KEY = 'skyreader-preferences';

function createPreferencesStore() {
  let state = $state<PreferencesState>({
    articleFont: 'serif',
    articleFontSize: 'md',
    readerViewMode: 'scroll',
    scrollToMarkAsRead: false,
    expandAllItems: true,
    sortOrder: 'newest',
    linkblogShareConfirmed: false,
    defaultView: 'home',
    dailyMagazineMinutes: 20,
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
        if (parsed.articleFontSize) {
          state.articleFontSize = parsed.articleFontSize;
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
        if (DAILY_MAGAZINE_MINUTE_OPTIONS.includes(parsed.dailyMagazineMinutes)) {
          state.dailyMagazineMinutes = parsed.dailyMagazineMinutes;
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
    state.articleFontSize = size;
    save();
  }

  function increaseFontSize() {
    const currentIndex = FONT_SIZE_ORDER.indexOf(state.articleFontSize);
    if (currentIndex < FONT_SIZE_ORDER.length - 1) {
      state.articleFontSize = FONT_SIZE_ORDER[currentIndex + 1];
      save();
    }
  }

  function decreaseFontSize() {
    const currentIndex = FONT_SIZE_ORDER.indexOf(state.articleFontSize);
    if (currentIndex > 0) {
      state.articleFontSize = FONT_SIZE_ORDER[currentIndex - 1];
      save();
    }
  }

  function resetFontSize() {
    state.articleFontSize = 'md';
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

  function setDailyMagazineMinutes(minutes: DailyMagazineMinutes) {
    if (!DAILY_MAGAZINE_MINUTE_OPTIONS.includes(minutes)) return;
    state.dailyMagazineMinutes = minutes;
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
    get dailyMagazineMinutes() {
      return state.dailyMagazineMinutes;
    },
    confirmLinkblogShare,
    setDefaultView,
    setDailyMagazineMinutes,
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
