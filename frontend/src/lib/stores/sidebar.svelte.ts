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

/* The tabs of the "+" Add modal (AddModal): one place for every way something
   comes into the reader. */
export type AddTab = 'web' | 'atmosphere' | 'newsletters' | 'save' | 'file';

interface SidebarState {
  isOpen: boolean; // For mobile overlay
  addModalTab: AddTab | null; // The Add modal's open tab, or null when closed
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
  // Width of the desktop navigation rail, in px (see RAIL_* bounds above).
  railWidth: number;
}

function createSidebarStore() {
  let state = $state<SidebarState>({
    isOpen: false,
    addModalTab: null,
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

  // The tab the Add modal last showed, so "+" reopens where the reader was.
  let lastAddTab: AddTab = 'web';

  function openAddModal(tab: AddTab = lastAddTab, initialValue = '') {
    // Opened over the navigation dropdown, the modal must be what's on top.
    state.navigationDropdownOpen = false;
    addSourceInitialValue = initialValue;
    lastAddTab = tab;
    state.addModalTab = tab;
  }

  function setAddModalTab(tab: AddTab, initialValue = '') {
    addSourceInitialValue = initialValue;
    addFeedModalInitialDid = null;
    lastAddTab = tab;
    state.addModalTab = tab;
  }

  function closeAddModal() {
    state.addModalTab = null;
    addFeedModalInitialDid = null;
    addSourceInitialValue = '';
  }

  function toggleAddModal() {
    if (state.addModalTab) closeAddModal();
    else openAddModal();
  }

  // Entry points that already know what is being added open straight to its tab.
  function openAddFeedModal(initialValue = '') {
    openAddModal('web', initialValue);
  }

  function openAddHandleModal(initialValue = '') {
    openAddModal('atmosphere', initialValue);
  }

  function openAddFeedModalForDid(did: string) {
    openAddModal('atmosphere');
    addFeedModalInitialDid = did;
  }

  function openSaveArticleModal() {
    openAddModal('save');
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
    get addModalTab() {
      return state.addModalTab;
    },
    get addFeedModalInitialDid() {
      return addFeedModalInitialDid;
    },
    get addSourceInitialValue() {
      return addSourceInitialValue;
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
    get railWidth() {
      return state.railWidth;
    },
    toggleMobile,
    closeMobile,
    toggleSection,
    toggleCategory,
    isCategoryExpanded,
    toggleShowOnlyUnread,
    openAddModal,
    setAddModalTab,
    closeAddModal,
    toggleAddModal,
    openAddFeedModal,
    openAddFeedModalForDid,
    openAddHandleModal,
    openSaveArticleModal,
    toggleNavigationDropdown,
    closeNavigationDropdown,
    setSortedFeedIds,
    setRailWidth,
    commitRailWidth,
    resetRailWidth,
    openChannelModal,
    closeChannelModal,
  };
}

export const sidebarStore = createSidebarStore();
