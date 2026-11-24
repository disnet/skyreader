import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import { SvelteMap } from 'svelte/reactivity';
import SavedFromHere from './SavedFromHere.svelte';

const SOURCE = 'https://example.com/the-article';
// Reactive, as the store's rows are: the list picks a new save up when it lands.
const saves = new SvelteMap<string, Record<string, unknown>>();
const save = (url: string, title: string) =>
  saves.set(url, {
    rkey: url,
    url,
    title,
    savedAt: new Date().toISOString(),
    savedFromUrl: SOURCE,
  });

vi.mock('$lib/stores/auth.svelte', () => ({ auth: { isGuest: false } }));
vi.mock('$lib/stores/saves.svelte', () => ({
  savesStore: {
    get articles() {
      return [...saves.values()];
    },
    getByUrl: (url: string) => saves.get(url),
  },
}));
vi.mock('$lib/services/api', () => ({ api: { pageTitles: vi.fn() } }));
vi.mock('$lib/utils/openInReader', () => ({ openKeyInReader: vi.fn() }));
vi.mock('$lib/utils/saveLink', () => ({
  saveLink: vi.fn((url: string) => {
    save(url, `Saved ${url}`);
    return Promise.resolve();
  }),
}));

const body = (n: number) =>
  `<p>${Array.from(
    { length: n },
    (_, i) => `<a href="https://elsewhere.example/page-${i}">page number ${i}</a>`
  ).join(' ')}</p>`;

let host: HTMLElement;
let instance: ReturnType<typeof mount> | null = null;

function render(html: string) {
  host = document.createElement('div');
  document.body.appendChild(host);
  instance = mount(SavedFromHere, { target: host, props: { url: SOURCE, title: 'T', html } });
  flushSync();
}

const rows = () => [...host.querySelectorAll('.row')].map((r) => r.textContent ?? '');
const unfold = () => host.querySelector<HTMLButtonElement>('.unfold');

afterEach(() => {
  if (instance) unmount(instance);
  instance = null;
  host?.remove();
  saves.clear();
});

describe('SavedFromHere, folded', () => {
  // The fold used to show only saves made from here, so an article you hadn't
  // saved from folded down to a heading and "Show all" with nothing between.
  it('shows the first few links when nothing was saved from here', () => {
    render(body(8));
    expect(rows()).toHaveLength(3);
    expect(rows()[0]).toContain('page number 0');
    expect(unfold()?.textContent).toContain('Show all 8 links');
  });

  it('shows every link, with nothing to unfold, when there are only a few', () => {
    render(body(2));
    expect(rows()).toHaveLength(2);
    expect(unfold()).toBeNull();
  });

  it('leads with what was saved from here when there is something', () => {
    save('https://elsewhere.example/page-5', 'A saved page');
    render(body(8));
    expect(rows()).toHaveLength(1);
    expect(rows()[0]).toContain('A saved page');
    expect(unfold()?.textContent).toContain('Show all 8 links');
  });

  // Saving from the preview mustn't fold the list to that one save under the pointer.
  it('keeps the preview in place when one of its links is saved', async () => {
    render(body(8));
    host.querySelectorAll<HTMLButtonElement>('.save')[1].click();
    await Promise.resolve();
    flushSync();
    expect(rows()).toHaveLength(3);
    expect(rows()[1]).toContain('Saved');
    expect(rows()[0]).toContain('page number 0');
  });
});
