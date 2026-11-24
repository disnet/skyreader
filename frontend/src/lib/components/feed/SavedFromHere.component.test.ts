import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import SavedFromHere from './SavedFromHere.svelte';

const SOURCE = 'https://example.com/the-article';
const saves: Array<Record<string, unknown>> = [];

vi.mock('$lib/stores/auth.svelte', () => ({ auth: { isGuest: false } }));
vi.mock('$lib/stores/saves.svelte', () => ({
  savesStore: {
    get articles() {
      return saves;
    },
    getByUrl: (url: string) => saves.find((s) => s.url === url),
  },
}));
vi.mock('$lib/services/api', () => ({ api: { pageTitles: vi.fn() } }));
vi.mock('$lib/utils/openInReader', () => ({ openKeyInReader: vi.fn() }));
vi.mock('$lib/utils/saveLink', () => ({ saveLink: vi.fn() }));

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
  saves.length = 0;
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
    saves.push({
      rkey: 'a',
      url: 'https://elsewhere.example/page-5',
      title: 'A saved page',
      savedAt: '2026-11-01T00:00:00Z',
      savedFromUrl: SOURCE,
    });
    render(body(8));
    expect(rows()).toHaveLength(1);
    expect(rows()[0]).toContain('A saved page');
    expect(unfold()?.textContent).toContain('Show all 8 links');
  });
});
