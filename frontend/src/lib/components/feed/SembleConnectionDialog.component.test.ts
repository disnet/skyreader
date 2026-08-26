import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';

const createSembleConnection = vi.fn(async () => ({
  uri: 'at://did:plc:reader/network.cosmik.connection/abc',
  cid: 'bafy',
  rkey: 'abc',
}));
let scopeStatus: Record<string, boolean> = { semble: true, margin: false, sembleConnections: true };
let sembleCards = [
  {
    uri: 'at://did:plc:reader/network.cosmik.card/c1',
    cid: 'bafycard',
    url: 'https://semble-only.test/connected-thinking',
    title: 'Connected thinking in Semble',
    author: 'A Semble author',
  },
];

class FakeScopeUpgradeError extends Error {}

vi.mock('$lib/services/api', () => ({
  api: {
    createSembleConnection: (...args: unknown[]) => createSembleConnection(...(args as [])),
    listSembleCards: vi.fn(async () => ({ cards: sembleCards, truncated: false })),
    getIntegrationStatus: vi.fn(async () => ({ scopeStatus })),
  },
  ScopeUpgradeError: FakeScopeUpgradeError,
}));

vi.mock('$lib/stores/auth.svelte', () => ({
  auth: {
    get user() {
      return { did: 'did:plc:reader', handle: 'reader.bsky.social', pdsUrl: 'https://pds.test' };
    },
  },
}));

vi.mock('$lib/stores/mentionLaneItems.svelte', () => ({
  mentionLaneItemsStore: { addSembleConnection: vi.fn() },
}));

const savedArticles = [
  {
    rkey: 'r1',
    uri: 'at://did:plc:reader/x/r1',
    url: 'https://other.test/the-rebuttal',
    title: 'A careful rebuttal',
    author: null,
    description: null,
    content: null,
    contentType: null,
    domain: 'other.test',
    image: null,
    wordCount: null,
    publishedAt: null,
    savedAt: '2026-01-01T00:00:00.000Z',
  },
  {
    rkey: 'r2',
    uri: 'at://did:plc:reader/x/r2',
    url: 'https://example.test/the-article/',
    title: 'The resolved article variant',
    author: null,
    description: null,
    content: null,
    contentType: null,
    domain: 'example.test',
    image: null,
    wordCount: null,
    publishedAt: null,
    savedAt: '2026-01-02T00:00:00.000Z',
  },
];

vi.mock('$lib/stores/saves.svelte', () => ({
  savesStore: {
    get articles() {
      return savedArticles;
    },
    load: vi.fn(async () => {}),
  },
}));

const Host = (await import('./SembleConnectionDialog.test-host.svelte')).default;
const { sembleConnectionStore } = await import('$lib/stores/sembleConnection.svelte');

let component: Record<string, unknown> | undefined;

function render(source?: { url: string; title?: string; cardUrl?: string }) {
  const target = document.createElement('div');
  document.body.appendChild(target);
  component = mount(Host, { target, props: source ? { source } : undefined }) as Record<
    string,
    unknown
  >;
  flushSync();
}

function q<T extends Element>(selector: string): T | null {
  return document.body.querySelector<T>(selector);
}

function pill(label: string): HTMLButtonElement {
  const found = [...document.body.querySelectorAll<HTMLButtonElement>('.type-pill')].find(
    (b) => b.textContent?.trim() === label
  );
  if (!found) throw new Error(`no "${label}" pill`);
  return found;
}

function typeInField(value: string) {
  const input = q<HTMLInputElement>('.search-input')!;
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  flushSync();
}

beforeEach(() => {
  createSembleConnection.mockClear();
  scopeStatus = { semble: true, margin: false, sembleConnections: true };
  sembleCards = [
    {
      uri: 'at://did:plc:reader/network.cosmik.card/c1',
      cid: 'bafycard',
      url: 'https://semble-only.test/connected-thinking',
      title: 'Connected thinking in Semble',
      author: 'A Semble author',
    },
  ];
});

afterEach(() => {
  if (component) unmount(component);
  component = undefined;
  sembleConnectionStore.close();
  document.body.innerHTML = '';
});

describe('SembleConnectionDialog', () => {
  it('cannot be submitted until the other end is named', () => {
    render();
    expect(q<HTMLButtonElement>('.btn-primary')!.disabled).toBe(true);

    typeInField('https://other.test/the-rebuttal');
    expect(q<HTMLButtonElement>('.btn-primary')!.disabled).toBe(false);
  });

  it('takes a pasted URL as the answer, without a confirming click', () => {
    render();
    typeInField('https://other.test/the-rebuttal');
    expect(q('.chosen-url')!.textContent).toBe('https://other.test/the-rebuttal');
  });

  it('refuses an edge from the article to itself', () => {
    render();
    typeInField('https://example.test/the-article');
    expect(document.body.textContent).toContain("That's the article you're on");
    expect(q<HTMLButtonElement>('.btn-primary')!.disabled).toBe(true);
  });

  it('refuses the exact URL variant resolved by the Semble card', () => {
    render({
      url: 'https://example.test/the-article',
      title: 'The Article',
      cardUrl: 'https://semble.so/url/https%3A%2F%2Fexample.test%2Fthe-article%2F',
    });
    typeInField('https://example.test/the-article/');

    expect(document.body.textContent).toContain("That's the article you're on");
    expect(q<HTMLButtonElement>('.btn-primary')!.disabled).toBe(true);
  });

  it('excludes the resolved Semble URL variant from Saved results', () => {
    render({
      url: 'https://example.test/the-article',
      title: 'The Article',
      cardUrl: 'https://semble.so/url/https%3A%2F%2Fexample.test%2Fthe-article%2F',
    });
    typeInField('resolved article variant');

    expect(q('.result')).toBeNull();
  });

  it('finds the other end in the reader own saved list', () => {
    render();
    typeInField('rebuttal');
    const result = q<HTMLButtonElement>('.result')!;
    expect(result.textContent).toContain('A careful rebuttal');

    result.click();
    flushSync();
    expect(q('.chosen-url')!.textContent).toBe('https://other.test/the-rebuttal');
  });

  it('finds cards created in Semble even when they are not saved in Skyreader', async () => {
    render();
    await vi.waitFor(() => {
      flushSync();
      typeInField('connected thinking');
      expect(q<HTMLButtonElement>('.result')?.textContent).toContain(
        'Connected thinking in Semble'
      );
    });

    q<HTMLButtonElement>('.result')!.click();
    flushSync();
    expect(q('.chosen-url')!.textContent).toBe('https://semble-only.test/connected-thinking');
  });

  it('shows search results in an anchored popover', () => {
    render();
    typeInField('rebuttal');

    expect(q('.results-popover')).not.toBeNull();
    expect(q('.search-shell')?.contains(q('.results-popover'))).toBe(true);
  });

  it('offers no swap for a non-directional relation', () => {
    render();
    // RELATED is the default and reads the same both ways.
    expect(q('.swap')).toBeNull();

    pill('supports').click();
    flushSync();
    expect(q('.swap')).not.toBeNull();

    pill('helpful').click();
    flushSync();
    expect(q('.swap')).toBeNull();
  });

  it('drops a flip made under a directional relation when a symmetric one is picked', async () => {
    render();
    typeInField('https://other.test/the-rebuttal');
    pill('supports').click();
    flushSync();
    q<HTMLButtonElement>('.swap')!.click();
    flushSync();

    pill('related').click();
    flushSync();
    q<HTMLButtonElement>('.btn-primary')!.click();
    await vi.waitFor(() => expect(createSembleConnection).toHaveBeenCalled());

    // Not reversed: the article is still the source.
    expect(createSembleConnection).toHaveBeenCalledWith({
      source: 'https://example.test/the-article',
      target: 'https://other.test/the-rebuttal',
      connectionType: 'RELATED',
      note: undefined,
    });
  });

  it('submits the relation, direction and note the reader chose', async () => {
    render();
    typeInField('https://other.test/the-rebuttal');
    pill('leads to').click();
    flushSync();
    q<HTMLButtonElement>('.swap')!.click();
    flushSync();

    const note = q<HTMLTextAreaElement>('.note')!;
    note.value = 'Read in this order.';
    note.dispatchEvent(new Event('input', { bubbles: true }));
    flushSync();

    q<HTMLButtonElement>('.btn-primary')!.click();
    await vi.waitFor(() => expect(createSembleConnection).toHaveBeenCalled());

    expect(createSembleConnection).toHaveBeenCalledWith({
      source: 'https://other.test/the-rebuttal',
      target: 'https://example.test/the-article',
      connectionType: 'LEADS_TO',
      note: 'Read in this order.',
    });
  });

  it('refuses a note over the lexicon limit', () => {
    render();
    typeInField('https://other.test/the-rebuttal');
    const note = q<HTMLTextAreaElement>('.note')!;
    note.value = 'a'.repeat(1001);
    note.dispatchEvent(new Event('input', { bubbles: true }));
    flushSync();

    expect(q<HTMLButtonElement>('.btn-primary')!.disabled).toBe(true);
  });

  it('says up front that a session without the scope will have to log in again', async () => {
    scopeStatus = { semble: true, margin: false, sembleConnections: false };
    render();
    await vi.waitFor(() => {
      flushSync();
      expect(document.body.textContent).toContain("You'll be asked to log in again");
    });
  });
});
