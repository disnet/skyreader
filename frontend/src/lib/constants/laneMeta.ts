import type { IconName } from '$lib/components/Icon.svelte';
import type { LaneId } from '$lib/components/articleCardView.types';

// Per-lane display metadata. The count + verb come from the network breakdown;
// this fixes the icon, name, and the create-affordance label per lane.
export const LANE_META: Record<
  LaneId,
  { icon: IconName; label: string; verb: string; noun: string; createLabel: string }
> = {
  linkblog: {
    icon: 'standard-site',
    label: 'Blogs',
    verb: 'noted',
    noun: 'note',
    createLabel: 'Write a note',
  },
  leaflet: {
    icon: 'leaflet',
    label: 'Leaflet',
    verb: 'commented',
    noun: 'comment',
    createLabel: 'Comment on Leaflet',
  },
  bluesky: {
    icon: 'bluesky',
    label: 'Bluesky',
    verb: 'posted',
    noun: 'post',
    createLabel: 'Post on Bluesky',
  },
  margin: {
    icon: 'margin',
    label: 'margin.at',
    verb: 'saved',
    noun: 'save',
    createLabel: 'Save to Margin',
  },
  semble: {
    icon: 'semble',
    label: 'Semble',
    verb: 'referenced',
    noun: 'save',
    createLabel: 'Save to Semble',
  },
};
export const LANE_ORDER: LaneId[] = ['linkblog', 'leaflet', 'bluesky', 'margin', 'semble'];
