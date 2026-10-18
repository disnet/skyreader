// The discussion arrives once, whole: it holds its skeleton until the stream
// first settles, then stays shown even if a late lane starts loading again.
import { describe, it, expect, afterEach } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';
import AtmospherePanel from './AtmospherePanel.svelte';
import type { DiscussionEntryVM, DiscussionStreamVM } from '../articleCardView.types';

const mounted: Record<string, any>[] = [];

afterEach(() => {
  for (const component of mounted.splice(0)) unmount(component);
  document.body.innerHTML = '';
});

function entry(did: string): DiscussionEntryVM {
  return {
    did,
    handle: `${did}.test`,
    displayName: null,
    avatar: null,
    createdAt: null,
    note: 'said something',
    url: null,
    collections: [],
    verb: null,
    quote: null,
    likeCount: null,
    key: `bluesky|${did}|`,
    lane: 'bluesky',
    laneLabel: 'Bluesky',
    laneIcon: 'bluesky',
    headVerb: 'posted',
    relativeTime: null,
    isoTime: null,
    cleanNote: 'said something',
  };
}

function render(stream: DiscussionStreamVM, itemUrl = 'https://example.com/a') {
  const props = $state({ stream, itemUrl, showHeading: true });
  const target = document.createElement('div');
  document.body.appendChild(target);
  mounted.push(mount(AtmospherePanel, { target, props }));
  flushSync();
  return { target, props };
}

const skeletons = (target: HTMLElement) => target.querySelector('.skeletons');
const rows = (target: HTMLElement) =>
  target.querySelectorAll('.discussion-stream:not(.skeletons) .entry').length;

describe('AtmospherePanel arrival', () => {
  it('holds the section with a skeleton before the stream is opened', () => {
    const { target } = render({ idle: true, loading: false, entries: [] });
    expect(skeletons(target)).not.toBeNull();
    expect(target.querySelector('.discussion-empty')).toBeNull();
  });

  it('shows nothing of a half-loaded stream, then all of it at once', () => {
    const { target, props } = render({ loading: true, entries: [entry('did:plc:a')] });
    expect(rows(target)).toBe(0);
    expect(skeletons(target)).not.toBeNull();

    props.stream = { loading: false, entries: [entry('did:plc:a'), entry('did:plc:b')] };
    flushSync();
    expect(rows(target)).toBe(2);
    expect(skeletons(target)).toBeNull();
  });

  it('keeps what it showed when a late lane starts loading', () => {
    const { target, props } = render({ loading: false, entries: [entry('did:plc:a')] });
    props.stream = { loading: true, entries: [entry('did:plc:a')] };
    flushSync();
    expect(rows(target)).toBe(1);
  });

  it('holds again for the next article', () => {
    const { target, props } = render({ loading: false, entries: [entry('did:plc:a')] });
    props.itemUrl = 'https://example.com/b';
    props.stream = { loading: true, entries: [] };
    flushSync();
    expect(rows(target)).toBe(0);
    expect(skeletons(target)).not.toBeNull();
  });

  it('says so when it settles empty under an article, rather than vanishing', () => {
    const { target } = render({ loading: false, entries: [] });
    expect(target.querySelector('.discussion-empty')?.textContent).toContain('No one');
  });
});
