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
    everything: boolean;
    saved: boolean;
  };
  showOnlyUnread: {
    shared: boolean;
    feeds: boolean;
  };
  // Sorted IDs for keyboard navigation (matches visual sidebar order)
  sortedFeedIds: number[];
  // Which categories are expanded in the Sources section
  expandedCategories: Record<string, boolean>;
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
      feeds: false,
      everything: true,
      saved: true,
    },
    showOnlyUnread: {
      shared: false,
      feeds: false,
    },
    sortedFeedIds: [],
    expandedCategories: {},
  });

  // Restore from localStorage on init
  if (browser) {
    const stored = localStorage.getItem('skyreader-sidebar');
    if (stored) {
      try {
        const parsed = JSON.parse(stored);
        // Migrate legacy `channels` key → both `everything` and `saved`
        const legacyChannels = parsed.expandedSections?.channels;
        const migrated = { ...parsed.expandedSections };
        if (legacyChannels != null) {
          if (migrated.everything == null) migrated.everything = legacyChannels;
          if (migrated.saved == null) migrated.saved = legacyChannels;
          delete migrated.channels;
        }
        state.expandedSections = {
          shared: false,
          feeds: false,
          everything: true,
          saved: true,
          ...migrated,
        };
        state.showOnlyUnread = parsed.showOnlyUnread ?? {
          shared: false,
          feeds: false,
        };
        state.expandedCategories = parsed.expandedCategories ?? {};
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
          expandedCategories: state.expandedCategories,
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

  function toggleSection(section: 'shared' | 'feeds' | 'everything' | 'saved') {
    state.expandedSections[section] = !state.expandedSections[section];
    persist();
  }

  function toggleCategory(category: string) {
    state.expandedCategories[category] = !state.expandedCategories[category];
    persist();
  }

  function isCategoryExpanded(category: string): boolean {
    return state.expandedCategories[category] ?? true; // default expanded
  }

  function toggleShowOnlyUnread(section: 'shared' | 'feeds') {
    state.showOnlyUnread[section] = !state.showOnlyUnread[section];
    persist();
  }

  let addFeedModalInitialDid = $state<string | null>(null);
  let addSourceInitialValue = $state<string>('');
  let channelModalOpen = $state(false);
  let editingChannelId = $state<number | null>(null);
  let initialChannelType = $state<'feed' | 'saved' | null>(null);

  function openAddFeedModal() {
    state.addFeedModalOpen = true;
  }

  function openAddFeedModalForDid(did: string) {
    addFeedModalInitialDid = did;
    state.addHandleModalOpen = true;
  }

  function closeAddFeedModal() {
    state.addFeedModalOpen = false;
    addSourceInitialValue = '';
  }

  function openAddHandleModal() {
    state.addHandleModalOpen = true;
  }

  function closeAddHandleModal() {
    state.addHandleModalOpen = false;
    addFeedModalInitialDid = null;
    addSourceInitialValue = '';
  }

  function setAddSourceInitialValue(value: string) {
    addSourceInitialValue = value;
  }

  function openSaveArticleModal() {
    state.saveArticleModalOpen = true;
  }

  function closeSaveArticleModal() {
    state.saveArticleModalOpen = false;
  }

  function openChannelModal(
    viewId: number | null = null,
    initialType: 'feed' | 'saved' | null = null
  ) {
    editingChannelId = viewId;
    initialChannelType = initialType;
    channelModalOpen = true;
  }

  function closeChannelModal() {
    channelModalOpen = false;
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
    get addSourceInitialValue() {
      return addSourceInitialValue;
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
    get channelModalOpen() {
      return channelModalOpen;
    },
    get editingChannelId() {
      return editingChannelId;
    },
    get initialChannelType() {
      return initialChannelType;
    },
    get expandedCategories() {
      return state.expandedCategories;
    },
    toggleMobile,
    closeMobile,
    toggleSection,
    toggleCategory,
    isCategoryExpanded,
    toggleShowOnlyUnread,
    openAddFeedModal,
    setAddSourceInitialValue,
    openAddFeedModalForDid,
    closeAddFeedModal,
    openAddHandleModal,
    closeAddHandleModal,
    openSaveArticleModal,
    closeSaveArticleModal,
    toggleNavigationDropdown,
    closeNavigationDropdown,
    setSortedFeedIds,
    openChannelModal,
    closeChannelModal,
  };
}

export const sidebarStore = createSidebarStore();
