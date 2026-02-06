class ViewTitleStore {
	current = $state('');
	unreadCount = $state(0);

	set(title: string, count: number = 0) {
		this.current = title;
		this.unreadCount = count;
	}
}

export const viewTitleStore = new ViewTitleStore();
