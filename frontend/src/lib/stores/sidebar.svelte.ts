import { browser } from '$app/environment';

interface SidebarState {
  isCollapsed: boolean;
  isOpen: boolean; // For mobile overlay
  expandedSections: {
    shared: boolean;
    feeds: boolean;
  };
  showOnlyUnread: {
    shared: boolean;
    feeds: boolean;
  };
}

function createSidebarStore() {
  let state = $state<SidebarState>({
    isCollapsed: false,
    isOpen: false,
    expandedSections: {
      shared: true,
      feeds: true,
    },
    showOnlyUnread: {
      shared: false,
      feeds: false,
    },
  });

  // Restore from localStorage on init
  if (browser) {
    const stored = localStorage.getItem('at-rss-sidebar');
    if (stored) {
      try {
        const parsed = JSON.parse(stored);
        state.isCollapsed = parsed.isCollapsed ?? false;
        state.expandedSections = parsed.expandedSections ?? { shared: true, feeds: true };
        state.showOnlyUnread = parsed.showOnlyUnread ?? { shared: false, feeds: false };
      } catch {
        // Ignore parse errors
      }
    }
  }

  function persist() {
    if (browser) {
      localStorage.setItem(
        'at-rss-sidebar',
        JSON.stringify({
          isCollapsed: state.isCollapsed,
          expandedSections: state.expandedSections,
          showOnlyUnread: state.showOnlyUnread,
        })
      );
    }
  }

  function toggle() {
    state.isCollapsed = !state.isCollapsed;
    persist();
  }

  function toggleMobile() {
    state.isOpen = !state.isOpen;
  }

  function closeMobile() {
    state.isOpen = false;
  }

  function toggleSection(section: 'shared' | 'feeds') {
    state.expandedSections[section] = !state.expandedSections[section];
    persist();
  }

  function toggleShowOnlyUnread(section: 'shared' | 'feeds') {
    state.showOnlyUnread[section] = !state.showOnlyUnread[section];
    persist();
  }

  return {
    get isCollapsed() {
      return state.isCollapsed;
    },
    get isOpen() {
      return state.isOpen;
    },
    get expandedSections() {
      return state.expandedSections;
    },
    get showOnlyUnread() {
      return state.showOnlyUnread;
    },
    toggle,
    toggleMobile,
    closeMobile,
    toggleSection,
    toggleShowOnlyUnread,
  };
}

export const sidebarStore = createSidebarStore();
