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
      if (feedUrl) {
        return {
          label: 'Publication',
          iconName: 'standard-site',
          pillClass: 'pill-publication',
        };
      }
      return {
        label: 'Documents',
        iconName: 'standard-site',
        pillClass: 'pill-documents',
      };
    case 'atproto.collection':
      return {
        label: 'Collection',
        iconName: 'folder',
        pillClass: 'pill-collection',
      };
    default:
      return { label: 'RSS', iconName: 'rss', pillClass: 'pill-rss' };
  }
}
