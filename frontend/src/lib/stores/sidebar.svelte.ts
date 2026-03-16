import { browser } from '$app/environment';

interface SidebarState {
  isOpen: boolean; // For mobile overlay
  addFeedModalOpen: boolean;
  addHandleModalOpen: boolean; // For add @handle modal
  saveArticleModalOpen: boolean; // For save article by URL modal
  navigationDropdownOpen: boolean; // For navigation dropdown
  expandedSections: {
    shared: boolean;
    feeds: boolean;
  };
  showOnlyUnread: {
    shared: boolean;
    feeds: boolean;
  };
  // Sorted IDs for keyboard navigation (matches visual sidebar order)
  sortedFeedIds: number[];
}

function createSidebarStore() {
  let state = $state<SidebarState>({
    isOpen: false,
    addFeedModalOpen: false,
    addHandleModalOpen: false,
    saveArticleModalOpen: false,
    navigationDropdownOpen: false,
    expandedSections: {
      shared: false,
      feeds: true,
    },
    showOnlyUnread: {
      shared: false,
      feeds: false,
    },
    sortedFeedIds: [],
  });

  // Restore from localStorage on init
  if (browser) {
    const stored = localStorage.getItem('skyreader-sidebar');
    if (stored) {
      try {
        const parsed = JSON.parse(stored);
        state.expandedSections = {
          shared: false,
          feeds: true,
          ...parsed.expandedSections,
        };
        state.showOnlyUnread = parsed.showOnlyUnread ?? { shared: false, feeds: false };
      } catch {
        // Ignore parse errors
      }
    }
  }

  function persist() {
    if (browser) {
      localStorage.setItem(
        'skyreader-sidebar',
        JSON.stringify({
          expandedSections: state.expandedSections,
          showOnlyUnread: state.showOnlyUnread,
        })
      );
    }
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

  let addFeedModalInitialDid = $state<string | null>(null);

  function openAddFeedModal() {
    state.addFeedModalOpen = true;
  }

  function openAddFeedModalForDid(did: string) {
    addFeedModalInitialDid = did;
    state.addHandleModalOpen = true;
  }

  function closeAddFeedModal() {
    state.addFeedModalOpen = false;
  }

  function openAddHandleModal() {
    state.addHandleModalOpen = true;
  }

  function closeAddHandleModal() {
    state.addHandleModalOpen = false;
    addFeedModalInitialDid = null;
  }

  function openSaveArticleModal() {
    state.saveArticleModalOpen = true;
  }

  function closeSaveArticleModal() {
    state.saveArticleModalOpen = false;
  }

  function toggleNavigationDropdown() {
    state.navigationDropdownOpen = !state.navigationDropdownOpen;
  }

  function closeNavigationDropdown() {
    state.navigationDropdownOpen = false;
  }

  function setSortedFeedIds(ids: number[]) {
    state.sortedFeedIds = ids;
  }

  return {
    get isOpen() {
      return state.isOpen;
    },
    get addFeedModalOpen() {
      return state.addFeedModalOpen;
    },
    get addHandleModalOpen() {
      return state.addHandleModalOpen;
    },
    get addFeedModalInitialDid() {
      return addFeedModalInitialDid;
    },
    get saveArticleModalOpen() {
      return state.saveArticleModalOpen;
    },
    get navigationDropdownOpen() {
      return state.navigationDropdownOpen;
    },
    get expandedSections() {
      return state.expandedSections;
    },
    get showOnlyUnread() {
      return state.showOnlyUnread;
    },
    get sortedFeedIds() {
      return state.sortedFeedIds;
    },
    toggleMobile,
    closeMobile,
    toggleSection,
    toggleShowOnlyUnread,
    openAddFeedModal,
    openAddFeedModalForDid,
    closeAddFeedModal,
    openAddHandleModal,
    closeAddHandleModal,
    openSaveArticleModal,
    closeSaveArticleModal,
    toggleNavigationDropdown,
    closeNavigationDropdown,
    setSortedFeedIds,
  };
}

export const sidebarStore = createSidebarStore();
