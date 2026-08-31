// Mounted component test (jsdom) — see the "component" project in vitest.config.ts.
import { describe, it, expect, afterEach } from 'vitest';
import { mount, unmount, flushSync, createRawSnippet } from 'svelte';
// Reached by path, not through `$app/navigation`: the alias in vitest.config.ts
// points both at this same module, but svelte-check resolves the specifier to
// SvelteKit's real types, which have no test controls on them.
import {
  simulateNavigation,
  simulateNavigationEnd,
  resetNavigation,
} from '../../../../test/stubs/app-navigation';
import Modal from './Modal.svelte';

const mounted: Record<string, unknown>[] = [];

function render(open = true) {
  let closed = 0;
  const target = document.createElement('div');
  document.body.appendChild(target);
  const component = mount(Modal, {
    target,
    props: {
      open,
      onclose: () => closed++,
      title: 'Add RSS Feed',
      children: createRawSnippet(() => ({
        render: () => `<div><a href="/supporter">Become a Supporter</a></div>`,
      })),
    },
  });
  flushSync();
  mounted.push(component);
  return { closed: () => closed };
}

describe('Modal', () => {
  afterEach(() => {
    for (const component of mounted.splice(0)) unmount(component);
    resetNavigation();
    document.body.innerHTML = '';
  });

  // A modal is rendered by the persistent shell, so a navigation underneath it
  // would otherwise leave the reader on the new page with the dialog still
  // covering it — the /supporter upsell inside the add-feed modal.
  it('closes when the app navigates away', () => {
    const state = render();
    simulateNavigation('link');
    expect(state.closed()).toBe(1);
  });

  it('closes on any cause of navigation, not just a link', () => {
    const state = render();
    simulateNavigation('popstate');
    expect(state.closed()).toBe(1);
  });

  it('ignores the tab being closed — there is no page left to uncover', () => {
    const state = render();
    simulateNavigation('leave');
    expect(state.closed()).toBe(0);
  });

  // The app redirects off '/' shortly after load. A reader quick enough to open
  // a modal in that window must not have it dismissed by a navigation that was
  // already under way before the dialog existed — only the arrival is left by
  // then, and reacting to arrivals would close it.
  it('ignores a navigation that began before it opened', () => {
    const state = render();
    simulateNavigationEnd('goto');
    expect(state.closed()).toBe(0);
  });

  // Every modal in the app is mounted whether or not it is showing; a closed
  // one must not fire onclose at its parent on every page change.
  it('stays quiet while it is closed', () => {
    const state = render(false);
    simulateNavigation('link');
    expect(state.closed()).toBe(0);
  });

  it('still closes on a backdrop click', () => {
    const state = render();
    document
      .querySelector('.modal-backdrop')!
      .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    flushSync();
    expect(state.closed()).toBe(1);
  });

  it('does not close when a click lands inside the dialog', () => {
    const state = render();
    document.querySelector('.modal')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    flushSync();
    expect(state.closed()).toBe(0);
  });
});
