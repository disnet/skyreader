import { browser } from '$app/environment';

/* The framed shell's navigation rail is drag-resizable, so its width is a user
   setting rather than a token. The bounds are the rail's own: below the minimum
   a channel name has nowhere to go, and past the maximum the reading card — the
   thing the rail exists to fill — starts losing more than it gains. */
export const RAIL_MIN_WIDTH = 220;
export const RAIL_MAX_WIDTH = 480;
export const RAIL_DEFAULT_WIDTH = 320;

function clampRailWidth(px: number): number {
  if (!Number.isFinite(px)) return RAIL_DEFAULT_WIDTH;
  return Math.round(Math.min(RAIL_MAX_WIDTH, Math.max(RAIL_MIN_WIDTH, px)));
}

interface SidebarState {
  isOpen: boolean; // For mobile overlay
  addFeedModalOpen: boolean;
  addHandleModalOpen: boolean; // For add @handle modal
  saveArticleModalOpen: boolean; // For save article by URL modal
  navigationDropdownOpen: boolean; // For navigation dropdown
  addMenuOpen: boolean; // For the "+" add menu (Add feed / @handle / Save URL / …)
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
  // Width of the desktop navigation rail, in px (see RAIL_* bounds above).
  railWidth: number;
}

function createSidebarStore() {
  let state = $state<SidebarState>({
    isOpen: false,
    addFeedModalOpen: false,
    addHandleModalOpen: false,
    saveArticleModalOpen: false,
    navigationDropdownOpen: false,
    addMenuOpen: false,
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
    railWidth: RAIL_DEFAULT_WIDTH,
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
        // Clamped on the way in as well as the way out: the bounds can move
        // between releases, and a stored width outside them would otherwise
        // stick until the user next dragged the handle.
        if (parsed.railWidth != null) state.railWidth = clampRailWidth(parsed.railWidth);
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
          railWidth: state.railWidth,
        })
      );
    }
  }

  /* Written on every pointermove of a drag, so it stays cheap: the clamp is
     arithmetic and the localStorage write is deferred to the end of the drag
     (commitRailWidth). */
  function setRailWidth(px: number) {
    state.railWidth = clampRailWidth(px);
  }

  function commitRailWidth() {
    persist();
  }

  function resetRailWidth() {
    state.railWidth = RAIL_DEFAULT_WIDTH;
    persist();
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

  // The sidebar "+" add source menu (AddSourceInput).
  function toggleAddMenu() {
    state.addMenuOpen = !state.addMenuOpen;
  }

  function closeAddMenu() {
    state.addMenuOpen = false;
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
    get addMenuOpen() {
      return state.addMenuOpen;
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
    get railWidth() {
      return state.railWidth;
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
    toggleAddMenu,
    closeAddMenu,
    setSortedFeedIds,
    setRailWidth,
    commitRailWidth,
    resetRailWidth,
    openChannelModal,
    closeChannelModal,
  };
}

export const sidebarStore = createSidebarStore();
