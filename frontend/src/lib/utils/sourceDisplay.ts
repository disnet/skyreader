import type { SubscriptionSourceType } from '$lib/types';

export interface SourceDisplayInfo {
  label: string;
  iconName: string;
  pillClass: string;
}

export function getSourceDisplay(
  sourceType: SubscriptionSourceType | undefined,
  feedUrl?: string
): SourceDisplayInfo {
  switch (sourceType) {
    case 'atproto.documents':
      if (feedUrl && feedUrl !== '__freestanding__') {
        return { label: 'Publication', iconName: 'newspaper', pillClass: 'pill-publication' };
      }
      return { label: 'Documents', iconName: 'file-text', pillClass: 'pill-documents' };
    case 'atproto.collection':
      return { label: 'Collection', iconName: 'folder', pillClass: 'pill-collection' };
    default:
      return { label: 'RSS', iconName: 'rss', pillClass: 'pill-rss' };
  }
}
