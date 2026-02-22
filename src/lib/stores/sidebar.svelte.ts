import { browser } from '$app/environment';

interface SidebarState {
  isOpen: boolean; // For mobile overlay
  addFeedModalOpen: boolean;
  followUserModalOpen: boolean; // For follow user modal
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
  sortedUserDids: string[];
  // Expanded users in Following section
  expandedUsers: Set<string>;
}

function createSidebarStore() {
  let state = $state<SidebarState>({
    isOpen: false,
    addFeedModalOpen: false,
    followUserModalOpen: false,
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
    sortedUserDids: [],
    expandedUsers: new Set(),
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
        state.expandedUsers = new Set(parsed.expandedUsers ?? []);
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
          expandedUsers: Array.from(state.expandedUsers),
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

  function openAddFeedModal() {
    state.addFeedModalOpen = true;
  }

  function closeAddFeedModal() {
    state.addFeedModalOpen = false;
  }

  function openFollowUserModal() {
    state.followUserModalOpen = true;
  }

  function closeFollowUserModal() {
    state.followUserModalOpen = false;
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

  function setSortedUserDids(dids: string[]) {
    state.sortedUserDids = dids;
  }

  function toggleUserExpanded(did: string) {
    if (state.expandedUsers.has(did)) {
      state.expandedUsers.delete(did);
    } else {
      state.expandedUsers.add(did);
    }
    state.expandedUsers = new Set(state.expandedUsers); // Trigger reactivity
    persist();
  }

  function isUserExpanded(did: string) {
    return state.expandedUsers.has(did);
  }

  return {
    get isOpen() {
      return state.isOpen;
    },
    get addFeedModalOpen() {
      return state.addFeedModalOpen;
    },
    get followUserModalOpen() {
      return state.followUserModalOpen;
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
    get sortedUserDids() {
      return state.sortedUserDids;
    },
    get expandedUsers() {
      return state.expandedUsers;
    },
    toggleMobile,
    closeMobile,
    toggleSection,
    toggleShowOnlyUnread,
    openAddFeedModal,
    closeAddFeedModal,
    openFollowUserModal,
    closeFollowUserModal,
    openSaveArticleModal,
    closeSaveArticleModal,
    toggleNavigationDropdown,
    closeNavigationDropdown,
    setSortedFeedIds,
    setSortedUserDids,
    toggleUserExpanded,
    isUserExpanded,
  };
}

export const sidebarStore = createSidebarStore();
