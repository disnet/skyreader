import { browser } from '$app/environment';

interface SidebarState {
	isCollapsed: boolean;
	isOpen: boolean; // For mobile overlay
	addFeedModalOpen: boolean;
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
}

function createSidebarStore() {
	let state = $state<SidebarState>({
		isCollapsed: false,
		isOpen: false,
		addFeedModalOpen: false,
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
	});

	// Restore from localStorage on init
	if (browser) {
		const stored = localStorage.getItem('skyreader-sidebar');
		if (stored) {
			try {
				const parsed = JSON.parse(stored);
				state.isCollapsed = parsed.isCollapsed ?? false;
				state.expandedSections = parsed.expandedSections ?? { shared: false, feeds: true };
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

	function openAddFeedModal() {
		state.addFeedModalOpen = true;
	}

	function closeAddFeedModal() {
		state.addFeedModalOpen = false;
	}

	function setSortedFeedIds(ids: number[]) {
		state.sortedFeedIds = ids;
	}

	function setSortedUserDids(dids: string[]) {
		state.sortedUserDids = dids;
	}

	return {
		get isCollapsed() {
			return state.isCollapsed;
		},
		get isOpen() {
			return state.isOpen;
		},
		get addFeedModalOpen() {
			return state.addFeedModalOpen;
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
		toggle,
		toggleMobile,
		closeMobile,
		toggleSection,
		toggleShowOnlyUnread,
		openAddFeedModal,
		closeAddFeedModal,
		setSortedFeedIds,
		setSortedUserDids,
	};
}

export const sidebarStore = createSidebarStore();
