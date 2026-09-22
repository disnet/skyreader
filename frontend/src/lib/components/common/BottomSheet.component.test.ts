// Mounted component test (jsdom) — see the "component" project in vitest.config.ts.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { mount, unmount, flushSync, createRawSnippet } from 'svelte';
import { reactiveBox } from '../../../../test/stubs/reactive-box.svelte';
import BottomSheet from './BottomSheet.svelte';

const mounted: Record<string, unknown>[] = [];

// Svelte sets `inert` as a DOM property, and jsdom doesn't reflect it back to
// the attribute the way a browser does — so check both.
function inertOf(el: Element | null): boolean {
  if (!el) return false;
  return el.hasAttribute('inert') || (el as HTMLElement).inert === true;
}

function render(props: { open: boolean; keepMounted?: boolean }) {
  const target = document.createElement('div');
  document.body.appendChild(target);
  const state = reactiveBox(props.open);
  const component = mount(BottomSheet, {
    target,
    props: {
      get open() {
        return state.value;
      },
      keepMounted: props.keepMounted,
      onclose: () => (state.value = false),
      title: 'Switch Feed',
      children: createRawSnippet(() => ({
        render: () => `<div><button>Saved</button></div>`,
      })),
    },
  });
  flushSync();
  mounted.push(component);
  return {
    setOpen(next: boolean) {
      state.value = next;
      flushSync();
    },
    // The sheet portals itself onto document.body, so it isn't under `target`.
    portal: () => document.querySelector('.bottom-sheet-portal'),
  };
}

describe('BottomSheet', () => {
  afterEach(() => {
    for (const component of mounted.splice(0)) unmount(component);
    document.body.innerHTML = '';
    document.body.style.overflow = '';
  });

  it('does not build its content until it is first opened', () => {
    const sheet = render({ open: false, keepMounted: true });
    expect(sheet.portal()).toBeNull();

    sheet.setOpen(true);
    expect(sheet.portal()).not.toBeNull();
  });

  // The whole point of keepMounted: the second open is a class toggle, so the
  // switcher's nav tree is built once rather than on every tap.
  it('keeps the sheet mounted across closes once opened', () => {
    const sheet = render({ open: false, keepMounted: true });
    sheet.setOpen(true);
    const first = sheet.portal();

    sheet.setOpen(false);
    expect(sheet.portal()).toBe(first);
    expect(first?.classList.contains('shown')).toBe(false);

    sheet.setOpen(true);
    expect(sheet.portal()).toBe(first);
    expect(first?.classList.contains('shown')).toBe(true);
  });

  // Without `inert` the hidden dialog stays tab-focusable and in the
  // accessibility tree, in front of the page the reader is actually on.
  it('makes a closed-but-mounted sheet inert', () => {
    const sheet = render({ open: false, keepMounted: true });
    sheet.setOpen(true);
    expect(inertOf(sheet.portal())).toBe(false);

    sheet.setOpen(false);
    expect(inertOf(sheet.portal())).toBe(true);
  });

  // A warm sheet must not hold the body scroll lock while it's hidden — but it
  // must hold it until it is actually gone. It stays on screen, covering the
  // page, for the length of its exit transition, and it is pointer-events:none
  // by then, so releasing on the first close frame lets a touch started in that
  // window scroll the page behind a sheet that still visually covers it.
  it('holds the body scroll lock until a warm sheet has finished animating out', () => {
    vi.useFakeTimers();
    try {
      const sheet = render({ open: false, keepMounted: true });
      sheet.setOpen(true);
      expect(document.body.style.overflow).toBe('hidden');

      sheet.setOpen(false);
      expect(document.body.style.overflow).toBe('hidden');

      vi.advanceTimersByTime(250);
      flushSync();
      expect(document.body.style.overflow).toBe('');
    } finally {
      vi.useRealTimers();
    }
  });

  // A lazy sheet is removed from the DOM in the same frame, so nothing is left
  // covering the page and the lock must not linger.
  it('releases the body scroll lock immediately without keepMounted', () => {
    const sheet = render({ open: true });
    expect(document.body.style.overflow).toBe('hidden');

    sheet.setOpen(false);
    expect(document.body.style.overflow).toBe('');
  });

  // Default behavior is unchanged for the other consumers (notifications,
  // filters): closing unmounts, so their content resets each time.
  it('unmounts on close without keepMounted', () => {
    const sheet = render({ open: true });
    expect(sheet.portal()).not.toBeNull();

    sheet.setOpen(false);
    expect(sheet.portal()).toBeNull();
  });
});
