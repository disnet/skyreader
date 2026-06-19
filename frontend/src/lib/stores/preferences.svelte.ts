import { browser } from '$app/environment';

export type ArticleFont = 'sans-serif' | 'serif' | 'mono' | 'literata';
export type ArticleFontSize = 'xs' | 'sm' | 'md' | 'lg' | 'xl';
export type BaseSortOrder = 'newest' | 'oldest';

const FONT_SIZE_ORDER: ArticleFontSize[] = ['xs', 'sm', 'md', 'lg', 'xl'];

interface PreferencesState {
  articleFont: ArticleFont;
  articleFontSize: ArticleFontSize;
  scrollToMarkAsRead: boolean;
  expandAllItems: boolean;
  sortOrder: BaseSortOrder;
  // Set once the user has acknowledged the first-share "this is public" confirmation.
  linkblogShareConfirmed: boolean;
}

const STORAGE_KEY = 'skyreader-preferences';

function createPreferencesStore() {
  let state = $state<PreferencesState>({
    articleFont: 'serif',
    articleFontSize: 'md',
    scrollToMarkAsRead: false,
    expandAllItems: true,
    sortOrder: 'newest',
    linkblogShareConfirmed: false,
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

  return {
    get articleFont() {
      return state.articleFont;
    },
    get articleFontSize() {
      return state.articleFontSize;
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
    confirmLinkblogShare,
    setArticleFont,
    setArticleFontSize,
    increaseFontSize,
    decreaseFontSize,
    resetFontSize,
    setScrollToMarkAsRead,
    setExpandAllItems,
    setSortOrder,
    toggleSortOrder,
  };
}

export const preferences = createPreferencesStore();
