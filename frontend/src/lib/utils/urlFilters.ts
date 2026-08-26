// The set of feed filters that live in the URL, and the comparison that decides
// whether an incoming URL actually moves the view.
//
// `feedViewStore.setFilters` runs on *every* URL change while FeedPage is mounted
// and unconditionally resets pagination, toolbar state and the saved search. The
// reader now writes `?read=` into the same URL (see `readerLink.ts`), so a URL
// change no longer implies a view change: without this comparison, opening an
// article would truncate the list back to one page under the open reader and
// corrupt the scroll position restored on close.

export interface UrlFilters {
  feed: string | null;
  saved: string | null;
  sharer: string | null;
  following: string | null;
  feeds: string | null;
  contentType?: 'documents' | null;
  view?: string | null;
  category?: string | null;
}

/** True when both filter sets select the same view (absent and null are equal). */
export function sameUrlFilters(a: UrlFilters, b: UrlFilters): boolean {
  return (
    a.feed === b.feed &&
    a.saved === b.saved &&
    a.sharer === b.sharer &&
    a.following === b.following &&
    a.feeds === b.feeds &&
    (a.contentType ?? null) === (b.contentType ?? null) &&
    (a.view ?? null) === (b.view ?? null) &&
    (a.category ?? null) === (b.category ?? null)
  );
}
