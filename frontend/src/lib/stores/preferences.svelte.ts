import { browser } from '$app/environment';

export type ArticleFont = 'sans-serif' | 'serif' | 'mono';
export type ArticleFontSize = 'xs' | 'sm' | 'md' | 'lg' | 'xl';

const FONT_SIZE_ORDER: ArticleFontSize[] = ['xs', 'sm', 'md', 'lg', 'xl'];

interface PreferencesState {
  articleFont: ArticleFont;
  articleFontSize: ArticleFontSize;
  scrollToMarkAsRead: boolean;
}

const STORAGE_KEY = 'skyreader-preferences';

function createPreferencesStore() {
  let state = $state<PreferencesState>({
    articleFont: 'sans-serif',
    articleFontSize: 'md',
    scrollToMarkAsRead: false,
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
    setArticleFont,
    setArticleFontSize,
    increaseFontSize,
    decreaseFontSize,
    resetFontSize,
    setScrollToMarkAsRead,
  };
}

export const preferences = createPreferencesStore();
