class ViewTitleStore {
  current = $state('');
  unreadCount = $state(0);
  // What's open in the reader, which outranks the host page's own title for as
  // long as it's up. Kept separate because the page sets `current` on unrelated
  // changes (a new unread count), which would otherwise clobber the article title
  // mid-read. See `useReaderStack`.
  override = $state<string | null>(null);

  set(title: string, count: number = 0) {
    this.current = title;
    this.unreadCount = count;
  }

  setOverride(title: string | null) {
    this.override = title;
  }
}

export const viewTitleStore = new ViewTitleStore();
