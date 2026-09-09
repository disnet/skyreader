import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, tick, unmount } from 'svelte';
import type { SkyNotification } from '$lib/types';

// The panel renders two kinds of notification from one list. A mention points
// out to a document on someone else's site; a feedback notification points back
// into this app, which is the distinction these cover — a new tab on an
// in-app route would leave the reader with a second copy of Skyreader.

let notifications: SkyNotification[] = [];

vi.mock('$lib/stores/notifications.svelte', () => ({
  notificationsStore: {
    get notifications() {
      return notifications;
    },
    get loading() {
      return false;
    },
    get loaded() {
      return true;
    },
  },
}));

const NotificationList = (await import('./NotificationList.svelte')).default;

function notification(overrides: Partial<SkyNotification>): SkyNotification {
  return {
    id: 'n1',
    type: 'mention',
    actorDid: 'did:plc:alice',
    actorHandle: 'alice.test',
    actorDisplayName: 'Alice',
    actorAvatar: null,
    sourceUri: 'at://did:plc:alice/site.standard.document/one',
    canonicalUrl: 'https://alice.example/post',
    title: 'A quieter reading mode',
    createdAt: Date.parse('2026-09-08T12:00:00Z'),
    seen: false,
    ...overrides,
  };
}

let component: Record<string, unknown> | undefined;

async function render() {
  const target = document.createElement('div');
  document.body.appendChild(target);
  component = mount(NotificationList, { target, props: { onItemClick: () => {} } }) as Record<
    string,
    unknown
  >;
  await tick();
  flushSync();
}

function item(): HTMLAnchorElement {
  return document.body.querySelector('.notif-item') as HTMLAnchorElement;
}

afterEach(() => {
  if (component) unmount(component);
  component = undefined;
  document.body.innerHTML = '';
});

describe('the notification panel', () => {
  it('renders a feedback status change as an in-app link', async () => {
    notifications = [
      notification({
        id: 'at://x#status:planned',
        type: 'feedback-status',
        detail: 'Now planned',
        canonicalUrl: '/feedback',
        actorHandle: null,
        actorDisplayName: null,
      }),
    ];
    await render();

    expect(item().textContent).toContain('Now planned');
    expect(item().textContent).toContain('on your feedback');
    expect(item().getAttribute('href')).toBe('/feedback');
    // In-app: no new tab, and no rel that only makes sense for one.
    expect(item().getAttribute('target')).toBeNull();
    expect(item().getAttribute('rel')).toBeNull();
    // No actor, so the circle carries what happened instead of a face.
    expect(document.body.querySelector('.notif-avatar.icon')).not.toBeNull();
  });

  it('renders a reply count', async () => {
    notifications = [
      notification({ type: 'feedback-reply', detail: '2 new replies', canonicalUrl: '/feedback' }),
    ];
    await render();
    expect(item().textContent).toContain('2 new replies');
  });

  it('refuses to treat a foreign URL as an in-app route', async () => {
    // A mention's canonicalUrl comes from someone else's record. "//evil.com"
    // is a path to the eye and another origin to the browser, so it must not
    // take the in-app branch and skip safeHref — which then rejects it outright,
    // since it is not an absolute http(s) URL.
    for (const hostile of ['//evil.com', '/\\evil.com', 'javascript:alert(1)']) {
      notifications = [notification({ canonicalUrl: hostile })];
      await render();
      expect(item().getAttribute('href')).toBeNull();
      expect(item().getAttribute('target')).toBe('_blank');
      if (component) unmount(component);
      component = undefined;
      document.body.replaceChildren();
    }
  });

  it('will not follow an in-app route on a notification it did not write', async () => {
    // Only our own feedback notifications get the unfiltered branch; a mention
    // claiming an app path is still sent through safeHref, which drops it.
    notifications = [notification({ canonicalUrl: '/settings' })];
    await render();
    expect(item().getAttribute('href')).toBeNull();
  });

  it('still opens a mention in a new tab', async () => {
    notifications = [notification({})];
    await render();

    expect(item().textContent).toContain('Alice');
    expect(item().textContent).toContain('mentioned you');
    expect(item().getAttribute('href')).toBe('https://alice.example/post');
    expect(item().getAttribute('target')).toBe('_blank');
    expect(item().getAttribute('rel')).toBe('noopener noreferrer');
  });
});
