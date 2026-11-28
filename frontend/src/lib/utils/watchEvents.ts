// What a watched save's update says, as a line the Watching lane can draw:
// plain text with the person or paper it names as a link. Pure, so the wording
// is tested without the lane (watchEvents.test.ts).

import type { IconName } from '$lib/components/Icon.svelte';
import type { WatchEvent, WatchEventDetail, WatchedLane } from '$lib/types';

export interface LineSegment {
  text: string;
  href?: string;
}

const LANE_ACTION: Record<WatchedLane, string> = {
  bluesky: 'posted it on Bluesky',
  leaflet: 'commented on it on Leaflet',
  linkblog: 'noted it on their blog',
  margin: 'annotated it on margin.at',
};

const LANE_ICON: Record<WatchedLane, 'bluesky' | 'leaflet' | 'standard-site' | 'margin'> = {
  bluesky: 'bluesky',
  leaflet: 'leaflet',
  linkblog: 'standard-site',
  margin: 'margin',
};

export function watchEventIcon(event: WatchEvent): IconName {
  if (event.kind === 'citations') return 'quote';
  return event.lane ? LANE_ICON[event.lane] : 'bell';
}

function safeUrl(url: string | null | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.href : undefined;
  } catch {
    return undefined;
  }
}

function personName(d: WatchEventDetail): string | null {
  return d.displayName?.trim() || (d.handle ? `@${d.handle}` : null);
}

function others(n: number, noun: string, plural = `${noun}s`): string {
  return `${n} ${n === 1 ? noun : plural}`;
}

/** The line for one update: who did what, or which paper cited it. */
export function watchEventLine(event: WatchEvent): LineSegment[] {
  if (event.kind === 'citations') {
    const first = event.detail.find((d) => d.title);
    if (!first) {
      return [{ text: `${others(event.count, 'new citation')}` }];
    }
    const rest = event.count - 1;
    return [
      { text: 'Cited by ' },
      { text: first.title!, href: safeUrl(first.url) },
      ...(rest > 0 ? [{ text: ` and ${others(rest, 'more paper', 'more papers')}` }] : []),
    ];
  }

  const action = event.lane ? LANE_ACTION[event.lane] : 'mentioned it';
  const named = event.detail.find((d) => personName(d));
  if (!named) {
    return [
      { text: `${event.count === 1 ? '1 more person' : `${event.count} more people`} ${action}` },
    ];
  }
  const rest = event.count - 1;
  return [
    { text: personName(named)!, href: safeUrl(named.url) },
    { text: `${rest > 0 ? ` and ${others(rest, 'other')}` : ''} ${action}` },
  ];
}

/** A short count for a badge or a label: "3 updates". */
export function updatesLabel(count: number): string {
  return `${count} ${count === 1 ? 'update' : 'updates'}`;
}
