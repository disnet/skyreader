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
  mentionLaneItemsStore: { addSembleConnection: vi.fn(), get: vi.fn() },
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

const readActivity = new Map<string, number>();
vi.mock('$lib/stores/itemLabels.svelte', () => ({
  itemLabelsStore: {
    getReadActivity: (keys: string[]) => {
      const at = Math.max(0, ...keys.map((key) => readActivity.get(key) ?? 0));
      return at ? { lastActivityAt: at, progress: null } : null;
    },
  },
}));

const Host = (await import('./SembleConnectionDialog.test-host.svelte')).default;
const { sembleConnectionStore } = await import('$lib/stores/sembleConnection.svelte');
const { recentReadsStore } = await import('$lib/stores/recentReads.svelte');

let component: Record<string, unknown> | undefined;

function render(
  source?: { url: string; title?: string; cardUrl?: string },
  other?: { url: string; title?: string },
  note?: string
) {
  const target = document.createElement('div');
  document.body.appendChild(target);
  const props = {
    ...(source ? { source } : {}),
    ...(other ? { other } : {}),
    ...(note ? { note } : {}),
  };
  component = mount(Host, { target, props }) as Record<string, unknown>;
  flushSync();
}

function recentTitles(): string[] {
  return [...document.body.querySelectorAll('.recent .result-title')].map(
    (el) => el.textContent?.trim() ?? ''
  );
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
  localStorage.clear();
  readActivity.clear();
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
  it('lists saves that have no record uri yet without colliding', () => {
    const blank = (rkey: string, url: string, title: string) => ({
      ...savedArticles[0],
      rkey,
      uri: '',
      url,
      title,
      savedAt: '2026-01-03T00:00:00.000Z',
    });
    savedArticles.push(
      blank('r3', 'https://imported.test/one', 'Imported one'),
      blank('r4', 'https://imported.test/two', 'Imported two')
    );
    try {
      render();
      expect(recentTitles()).toEqual(expect.arrayContaining(['Imported one', 'Imported two']));
    } finally {
      savedArticles.splice(2);
    }
  });

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

  // Floating, so typing never reflows the dialog — and fixed rather than
  // absolute, since the scrolling modal body clips an absolute child.
  it('shows search results in a fixed popover anchored to the field', () => {
    render();
    typeInField('rebuttal');

    const popover = q<HTMLElement>('.results-popover');
    expect(popover).not.toBeNull();
    expect(q('.search-shell')?.contains(popover)).toBe(true);
    // Scoped component CSS isn't applied here, so the proof that the popover
    // is placed against the field is the geometry the measure pass writes.
    expect(popover!.style.top).not.toBe('');
    expect(popover!.style.left).not.toBe('');
    expect(popover!.style.maxHeight).not.toBe('');
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

  it('lists recent reads and saves before the reader types, newest first', () => {
    // r1 was saved first but read just now, so it outranks r2's later save.
    readActivity.set('r1', Date.parse('2026-01-05T00:00:00.000Z'));
    recentReadsStore.record('https://elsewhere.test/read-last-night', 'Read last night');
    render();

    expect(recentTitles()).toEqual(['Read last night', 'A careful rebuttal']);
  });

  it('leaves the article itself, in any URL variant, out of the recent list', () => {
    recentReadsStore.record('https://example.test/the-article/', 'The Article again');
    render();

    expect(recentTitles()).not.toContain('The Article again');
    // The save holding the slash variant is the same article too.
    expect(recentTitles()).not.toContain('The resolved article variant');
  });

  it('takes a recent read as the other end in one tap', () => {
    recentReadsStore.record('https://elsewhere.test/read-last-night', 'Read last night');
    render();

    q<HTMLButtonElement>('.recent .result')!.click();
    flushSync();
    expect(q('.chosen-url')!.textContent).toBe('https://elsewhere.test/read-last-night');
    expect(q<HTMLButtonElement>('.btn-primary')!.disabled).toBe(false);
  });

  it('puts recent matches ahead of older ones when searching', () => {
    sembleCards = [
      {
        uri: 'at://did:plc:reader/network.cosmik.card/c2',
        cid: 'bafycard2',
        url: 'https://semble-only.test/an-old-rebuttal',
        title: 'An old rebuttal on Semble',
        author: 'Someone',
      },
    ];
    recentReadsStore.record('https://elsewhere.test/fresh-rebuttal', 'A fresh rebuttal');
    render();
    typeInField('rebuttal');

    const titles = [...document.body.querySelectorAll('.results-popover .result-title')].map((el) =>
      el.textContent?.trim()
    );
    expect(titles[0]).toBe('A fresh rebuttal');
  });

  it('lists an article once, whichever URL variant each source holds', () => {
    // r1 is saved without the slash.
    recentReadsStore.record('https://other.test/the-rebuttal/', 'A careful rebuttal');
    render();

    expect(recentTitles().filter((t) => t === 'A careful rebuttal')).toHaveLength(1);
  });

  it("doesn't let a recent read hide the fuller save of the same article", () => {
    savedArticles[0].author = 'Jane Smith' as never;
    try {
      recentReadsStore.record('https://other.test/the-rebuttal', 'A careful rebuttal');
      render();
      typeInField('smith');
      expect(q('.results-popover .result-title')?.textContent).toBe('A careful rebuttal');
    } finally {
      savedArticles[0].author = null;
    }
  });

  it('ranks a fresh Semble card ahead of older saves when searching', async () => {
    sembleCards = [
      {
        uri: 'at://did:plc:reader/network.cosmik.card/c3',
        cid: 'bafycard3',
        url: 'https://semble-only.test/fresh-rebuttal',
        title: 'A fresh rebuttal on Semble',
        author: 'Someone',
        createdAt: '2026-02-01T00:00:00.000Z',
      } as never,
    ];
    render();
    await vi.waitFor(() => {
      typeInField('rebuttal');
      expect(q('.results-popover .result-title')?.textContent).toBe('A fresh rebuttal on Semble');
    });
  });

  it('opens with the other end filled when the opener names it', () => {
    render(
      { url: 'https://example.test/the-article', title: 'The Article' },
      { url: 'https://elsewhere.test/read-last-night', title: 'Read last night' }
    );

    expect(q('.chosen-url')!.textContent).toBe('https://elsewhere.test/read-last-night');
    expect(q('.search-input')).toBeNull();
    expect(q<HTMLButtonElement>('.btn-primary')!.disabled).toBe(false);
  });

  // A guessed end is one pick among the library, not a given.
  it('keeps the library in view under an end that was filled in for the reader', () => {
    recentReadsStore.record('https://elsewhere.test/read-last-night', 'Read last night');
    render(
      { url: 'https://example.test/the-article', title: 'The Article' },
      { url: 'https://elsewhere.test/read-last-night', title: 'Read last night' }
    );

    // The guess isn't offered again as its own alternative.
    expect(recentTitles()).toEqual(['A careful rebuttal']);
    q<HTMLButtonElement>('.recent .result')!.click();
    flushSync();
    expect(q('.chosen-url')!.textContent).toBe('https://other.test/the-rebuttal');

    q<HTMLButtonElement>('.search-library')!.click();
    flushSync();
    expect(q('.chosen')).toBeNull();
    expect(q('.search-input')).not.toBeNull();
  });

  it('opens with the passage it was drawn from in the note, and sends it', async () => {
    render(
      { url: 'https://example.test/the-article', title: 'The Article' },
      undefined,
      '“A passage.”'
    );
    expect(q<HTMLTextAreaElement>('.note')!.value).toBe('“A passage.”');

    typeInField('https://other.test/the-rebuttal');
    q<HTMLButtonElement>('.btn-primary')!.click();
    await vi.waitFor(() => expect(createSembleConnection).toHaveBeenCalled());
    expect(createSembleConnection).toHaveBeenCalledWith(
      expect.objectContaining({ note: '“A passage.”' })
    );
  });

  it('says the connection will be public before it is drawn', () => {
    render();
    expect(q('.public-note')?.textContent?.trim()).toBe('Connections are public on Semble.');
  });

  it('offers the Semble permission up front when the session lacks the scope', async () => {
    scopeStatus = { semble: true, margin: false, sembleConnections: false };
    render();
    await vi.waitFor(() => {
      flushSync();
      expect(document.body.textContent).toContain('Semble needs your permission');
      expect(document.querySelector('.notice-action')?.textContent).toBe('Allow access');
    });
  });
});
