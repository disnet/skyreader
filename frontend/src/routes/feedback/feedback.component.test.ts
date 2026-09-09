import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount, tick } from 'svelte';
// Type-only: the module itself is mocked below, so this is erased at runtime.
import type { FeedbackBoard } from '$lib/services/api';

// The page's whole job is to make a third party's board legible: one list in
// the reader's chosen order, scoped to what's open or what's closed, and a way
// to post without leaving. These mount it against a stubbed API so each of
// those is checked in a real DOM.

class FakeScopeUpgradeError extends Error {}

const board = {
  spaceUrl: 'https://userinput.app/s/did:plc:space/rkey',
  total: 3,
  complete: true,
  types: [
    { value: 'bug', label: 'Bug' },
    { value: 'feature', label: 'Feature request' },
  ],
  posts: [
    {
      uri: 'at://did:plc:alice/app.userinput.discussion/one',
      url: 'https://userinput.app/d/did:plc:alice/one',
      author: { did: 'did:plc:alice', handle: 'alice.test', displayName: 'Alice', avatar: null },
      title: 'Add focus mode',
      body: '',
      tags: ['feature'],
      createdAt: '2026-09-01T12:00:00Z',
      votes: { up: 12, down: 2, net: 10 },
      replyCount: 2,
      status: 'planned',
    },
    {
      uri: 'at://did:plc:bob/app.userinput.discussion/two',
      url: 'https://userinput.app/d/did:plc:bob/two',
      author: { did: 'did:plc:bob', handle: 'bob.test', displayName: null, avatar: null },
      title: 'Fix feed refresh',
      body: '',
      tags: ['bug'],
      createdAt: '2026-09-02T12:00:00Z',
      votes: { up: 5, down: 1, net: 4 },
      replyCount: 0,
      status: null,
    },
    {
      uri: 'at://did:plc:carol/app.userinput.discussion/three',
      url: 'https://userinput.app/d/did:plc:carol/three',
      author: { did: 'did:plc:carol', handle: 'carol.test', displayName: null, avatar: null },
      title: 'An untagged wish',
      body: '',
      tags: [],
      createdAt: '2026-09-03T12:00:00Z',
      votes: { up: 1, down: 0, net: 1 },
      replyCount: 0,
      status: null,
    },
  ],
};

let scopeStatus: Record<string, boolean> = {
  semble: false,
  margin: false,
  userinput: true,
  userinputImages: true,
};
// Typed as the real response so a fixture with a differently-shaped post (a
// null displayName, say) is checked against the API's own type rather than
// against the literal type TypeScript inferred from this one fixture.
const getFeedbackBoard = vi.fn(async (): Promise<FeedbackBoard> => structuredClone(board));
// Whether the backend's best-effort self-upvote landed. It doesn't when the
// session lacks the vote scope, or when the PDS refuses that second write.
let selfUpvoted = true;
const createFeedbackPost = vi.fn(async (_input: { title: string; body?: string }) => ({
  uri: 'at://did:plc:reader/app.userinput.discussion/fresh',
  cid: 'bafyfresh',
  url: 'https://userinput.app/d/did:plc:reader/fresh',
  createdAt: '2026-09-08T12:00:00Z',
  upvoted: selfUpvoted,
}));

// One post's replies, fetched when a reader expands it (or, for their own
// posts, when the page opens). Text-only records in their authors' repos.
const replies = [
  {
    uri: 'at://did:plc:maintainer/app.userinput.reply/one',
    parentUri: null,
    author: {
      did: 'did:plc:maintainer',
      handle: 'skyreader.app',
      displayName: 'Skyreader',
      avatar: null,
      mod: true,
    },
    body: 'Landing in the next release.',
    createdAt: '2026-09-04T12:00:00Z',
    editedAt: null,
    votes: { up: 1, down: 0, net: 1 },
  },
  {
    uri: 'at://did:plc:bob/app.userinput.reply/two',
    parentUri: 'at://did:plc:maintainer/app.userinput.reply/one',
    author: { did: 'did:plc:bob', handle: 'bob.test', displayName: null, avatar: null, mod: false },
    body: 'Thanks!',
    createdAt: '2026-09-05T12:00:00Z',
    editedAt: null,
    votes: { up: 0, down: 0, net: 0 },
  },
];
let threadFails = false;
const getFeedbackThread = vi.fn(async (_did: string, _rkey: string) => {
  if (threadFails) throw new Error('upstream said no');
  return { total: replies.length, complete: true, replies: structuredClone(replies) };
});

// The uploaded blob a composer attachment carries into the post.
const uploadedBlob = {
  $type: 'blob' as const,
  ref: { $link: 'bafkreiuploaded' },
  mimeType: 'image/png',
  size: 11,
};
let uploadFails: 'no' | 'scope' | 'error' = 'no';
const uploadFeedbackImage = vi.fn(async (_file: File) => {
  if (uploadFails === 'scope') throw new FakeScopeUpgradeError('nope');
  if (uploadFails === 'error') throw new Error('upstream said no');
  return { blob: uploadedBlob };
});

vi.mock('$lib/services/api', () => ({
  api: {
    getFeedbackBoard: () => getFeedbackBoard(),
    getIntegrationStatus: vi.fn(async () => ({ scopeStatus })),
    createFeedbackPost: (input: { title: string; body?: string }) => createFeedbackPost(input),
    getFeedbackThread: (did: string, rkey: string) => getFeedbackThread(did, rkey),
    uploadFeedbackImage: (file: File) => uploadFeedbackImage(file),
  },
  ScopeUpgradeError: FakeScopeUpgradeError,
  FEEDBACK_IMAGE_TYPES: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'],
  FEEDBACK_IMAGE_MAX_BYTES: 1_000_000,
  FEEDBACK_IMAGE_MAX: 4,
}));

// The in-app chrome pulls the whole navigation tree (and `$app/stores`) behind
// it; this page renders it only for a signed-in reader inside the app, and none
// of these cases are that.
vi.mock('$lib/components/feed/StaticPageChrome.svelte', () => ({ default: () => {} }));

vi.mock('$lib/stores/auth.svelte', () => ({
  auth: {
    get isInApp() {
      return false;
    },
    get isAuthenticated() {
      return true;
    },
    get user() {
      return { did: 'did:plc:reader', handle: 'reader.test', pdsUrl: 'https://pds.test' };
    },
    logout: vi.fn(async () => {}),
  },
}));

const Page = (await import('./+page.svelte')).default;

let component: Record<string, unknown> | undefined;

async function render() {
  const target = document.createElement('div');
  document.body.appendChild(target);
  component = mount(Page, { target }) as Record<string, unknown>;
  await tick();
  await tick();
  flushSync();
}

function texts(selector: string): string[] {
  return [...document.body.querySelectorAll(selector)].map((el) => el.textContent?.trim() ?? '');
}

/**
 * A chip in one of the filter rows. Both control sets are always in the DOM —
 * a container query displays one of them — so each helper here names the one it
 * drives, and both are exercised below.
 */
function chip(group: string, label: string): HTMLButtonElement {
  const scope = document.body.querySelector(`.chip-controls [aria-label="${group}"]`);
  const found = [...(scope?.querySelectorAll('button') ?? [])].find(
    (candidate) => candidate.textContent?.trim() === label
  );
  if (!found) throw new Error(`no "${label}" chip under ${group}`);
  return found;
}

/** The narrow-width equivalent: choose an option on one of the dropdowns. */
async function choose(label: string, optionText: string) {
  const group = [...document.body.querySelectorAll('.menu-controls .control-group')].find(
    (candidate) => candidate.querySelector('span')?.textContent?.trim() === label
  );
  const select = group?.querySelector('select');
  if (!select) throw new Error(`no "${label}" dropdown above the list`);
  const option = [...select.options].find((candidate) => candidate.text === optionText);
  if (!option) throw new Error(`no "${optionText}" option under ${label}`);
  select.value = option.value;
  select.dispatchEvent(new Event('change', { bubbles: true }));
  await tick();
  flushSync();
}

async function click(element: HTMLElement) {
  element.click();
  await tick();
  flushSync();
}

/** The net-vote count rendered on a post row, by title. */
function votes(title: string): string {
  const post = [...document.body.querySelectorAll('.post')].find(
    (candidate) => candidate.querySelector('h3')?.textContent?.trim() === title
  );
  if (!post) throw new Error(`no post titled "${title}"`);
  return post.querySelector('.meta span')?.getAttribute('aria-label') ?? '';
}

/**
 * jsdom lays nothing out, so a clamped paragraph reports no overflow and the
 * page's "Show more" would never appear. Fake the one measurement it makes: a
 * closed body overflows its two lines, an open one doesn't.
 */
globalThis.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
Object.defineProperty(HTMLParagraphElement.prototype, 'clientHeight', {
  configurable: true,
  get() {
    return 40;
  },
});
Object.defineProperty(HTMLParagraphElement.prototype, 'scrollHeight', {
  configurable: true,
  get(this: HTMLParagraphElement) {
    return this.classList.contains('body') && !this.classList.contains('open') ? 120 : 40;
  },
});

/** jsdom has no object URLs; the composer makes one per preview. */
const objectUrls = { created: 0, revoked: 0 };
URL.createObjectURL = () => `blob:preview-${objectUrls.created++}`;
URL.revokeObjectURL = () => {
  objectUrls.revoked++;
};

function png(name: string, size = 11): File {
  const file = new File(['not-really'], name, { type: 'image/png' });
  Object.defineProperty(file, 'size', { value: size });
  return file;
}

/** Pick files on the composer's file input, the way a reader would. */
async function attach(files: File[]) {
  const input = document.body.querySelector<HTMLInputElement>('.composer .file-input')!;
  Object.defineProperty(input, 'files', { value: files, configurable: true });
  input.dispatchEvent(new Event('change', { bubbles: true }));
  await tick();
  await tick();
  flushSync();
}

function composerField<T extends HTMLElement>(selector: string): T {
  return document.body.querySelector<T>(`.composer ${selector}`)!;
}

/** The title input, told apart from the radios, the file picker and the alts. */
function titleField(): HTMLInputElement {
  return composerField<HTMLInputElement>('input:not([type]):not(.alt)');
}

/** The type track's radios, in the order the composer offers them. */
function typeRadios(): HTMLInputElement[] {
  return [...document.body.querySelectorAll<HTMLInputElement>('.composer .segment input')];
}

function checkedType(): string | undefined {
  return typeRadios().find((radio) => radio.checked)?.value;
}

async function openComposer() {
  await click(document.body.querySelector('.post-link') as HTMLElement);
}

async function fillPost(title: string, type = 'bug') {
  const field = titleField();
  field.value = title;
  field.dispatchEvent(new Event('input', { bubbles: true }));
  flushSync();
  // '' means "leave the track alone" — a radio track has no unselected option to
  // pick, which is exactly why the default matters.
  if (type) {
    typeRadios()
      .find((radio) => radio.value === type)!
      .click();
    await tick();
    flushSync();
  }
}

async function submitForm() {
  document.body.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true }));
  await tick();
  await tick();
  flushSync();
}

async function submitPost(title: string) {
  await openComposer();
  await fillPost(title);
  await submitForm();
}

/**
 * The fixture board plus the two settled posts the status switch exists for:
 * everything else on this board is still open.
 */
function boardWithClosed(): FeedbackBoard {
  const settled = structuredClone(board.posts[1]);
  return {
    ...structuredClone(board),
    posts: [
      ...structuredClone(board.posts),
      {
        ...settled,
        uri: 'at://did:plc:dan/x/four',
        title: 'Already shipped',
        status: 'implemented',
      },
      { ...settled, uri: 'at://did:plc:dan/x/five', title: 'Not happening', status: 'declined' },
    ],
  };
}

/** Close the page and open it again, the way a reload does. */
async function reload() {
  if (component) unmount(component);
  component = undefined;
  document.body.innerHTML = '';
  await render();
}

/** The titles under a section heading, in order. */
function sectionTitles(selector: string): string[] {
  const section = document.body.querySelector(selector);
  return [...(section?.querySelectorAll('.post h3') ?? [])].map(
    (el) => el.textContent?.trim() ?? ''
  );
}

beforeEach(() => {
  localStorage.clear();
  threadFails = false;
  getFeedbackThread.mockClear();
  scopeStatus = { semble: false, margin: false, userinput: true, userinputImages: true };
  selfUpvoted = true;
  uploadFails = 'no';
  getFeedbackBoard.mockClear();
  createFeedbackPost.mockClear();
  uploadFeedbackImage.mockClear();
});

afterEach(() => {
  if (component) unmount(component);
  component = undefined;
  document.body.innerHTML = '';
});

describe('the feedback board', () => {
  it('shows one list in the chosen order, whatever each post is filed under', async () => {
    // Type is a filter and a pill on the row, not a partition — most-voted
    // first, and the untyped post sorts with the rest rather than after them.
    await render();
    expect(texts('.post h3')).toEqual(['Add focus mode', 'Fix feed refresh', 'An untagged wish']);

    await click(chip('Sort feedback', 'New'));
    expect(texts('.post h3')).toEqual(['An untagged wish', 'Fix feed refresh', 'Add focus mode']);
  });

  it('labels each post with its type, and never filters on one', async () => {
    // Type is what a post calls itself, not a way to cut the board down: the
    // pill is on the row, and there is no control anywhere that hides a type.
    await render();
    expect(texts('.post .tag')).toEqual(['Feature request', 'Bug']);
    expect(document.body.querySelector('[aria-label="Filter by type"]')).toBeNull();
    expect(texts('.menu-controls .control-group span')).not.toContain('Type');
    expect(texts('.post h3')).toHaveLength(3);
  });

  it('labels a type the board has since dropped from its vocabulary', async () => {
    // Upstream data outlives a board's tag config, and the pill has to say
    // something better than the raw slug.
    getFeedbackBoard.mockImplementationOnce(async () => ({
      ...structuredClone(board),
      types: [{ value: 'bug', label: 'Bug' }],
      posts: [{ ...structuredClone(board.posts[0]), tags: ['retired-tag'] }],
    }));
    await render();
    expect(texts('.post .tag')).toEqual(['Retired tag']);
  });

  it('hides settled feedback by default, and hands back the archive', async () => {
    getFeedbackBoard.mockImplementationOnce(async () => boardWithClosed());
    await render();

    // A board keeps everything it ever shipped; what a reader wants first is
    // what is still live. Planned and untriaged are both still live.
    expect(texts('.post h3')).toEqual(['Add focus mode', 'Fix feed refresh', 'An untagged wish']);

    await click(chip('Filter by status', 'Closed'));
    expect(texts('.post h3')).toEqual(['Already shipped', 'Not happening']);

    await click(chip('Filter by status', 'All'));
    expect(texts('.post h3')).toHaveLength(5);
  });

  it('offers the same three from the narrow-width dropdown', async () => {
    getFeedbackBoard.mockImplementationOnce(async () => boardWithClosed());
    await render();
    await choose('Status', 'Closed');
    expect(texts('.post h3')).toEqual(['Already shipped', 'Not happening']);
    // Both control sets read the same state.
    expect(chip('Filter by status', 'Closed').getAttribute('aria-pressed')).toBe('true');
  });

  it('says so, and offers the way through, when nothing is open', async () => {
    getFeedbackBoard.mockImplementationOnce(async () => ({
      ...boardWithClosed(),
      posts: boardWithClosed().posts.filter((post) => post.status === 'implemented'),
    }));
    await render();
    expect(document.body.textContent).toContain('Nothing open here.');

    await click(document.body.querySelector('.state button') as HTMLElement);
    expect(texts('.post h3')).toEqual(['Already shipped']);
  });

  it('shows no status control on a board that has closed nothing', async () => {
    // One side of a two-sided switch is not a choice.
    await render();
    expect(document.body.querySelector('[aria-label="Filter by status"]')).toBeNull();
  });

  it('posts from the page and shows the new post before upstream indexes it', async () => {
    await render();
    await submitPost('Sync highlights faster');

    expect(createFeedbackPost).toHaveBeenCalledWith({
      title: 'Sync highlights faster',
      body: undefined,
      tags: ['bug'],
    });
    // No reload: upstream aggregates by backlink and wouldn't return it yet.
    expect(getFeedbackBoard).toHaveBeenCalledTimes(1);
    expect(texts('.post h3')).toContain('Sync highlights faster');
    expect(votes('Sync highlights faster')).toBe('1 net votes');
    expect(document.body.textContent).toContain('Posted.');
  });

  it('opens a clipped description in full, and closes it again', async () => {
    const long = 'A long report.\nWith a second line, and more than two lines of it.';
    getFeedbackBoard.mockImplementationOnce(async () => ({
      ...structuredClone(board),
      posts: [{ ...structuredClone(board.posts[0]), body: long }],
    }));
    await render();

    const body = document.body.querySelector('.body')!;
    expect(body.classList.contains('open')).toBe(false);
    const more = document.body.querySelector('.more') as HTMLButtonElement;
    expect(more.textContent?.trim()).toBe('Show more');
    // The row is one of many, so the button says which post it opens.
    expect(more.getAttribute('aria-label')).toBe('Show more of Add focus mode');

    await click(more);
    expect(body.classList.contains('open')).toBe(true);
    expect(body.textContent).toBe(long);
    expect(texts('.more')).toEqual(['Show less']);

    await click(document.body.querySelector('.more') as HTMLElement);
    expect(document.body.querySelector('.body')?.classList.contains('open')).toBe(false);
    // Still offered: closing it can't be a one-way door.
    expect(texts('.more')).toEqual(['Show more']);
  });

  it('offers nothing to open on a description that already fits', async () => {
    // Every fixture post but the first has an empty body, so nothing is clipped.
    await render();
    expect(document.body.querySelector('.more')).toBeNull();
  });

  it('expands a post to show its replies, and collapses without re-fetching', async () => {
    await render();
    const toggle = [...document.body.querySelectorAll<HTMLButtonElement>('.reply-toggle')].find(
      (candidate) => candidate.textContent?.includes('2 replies')
    )!;
    await click(toggle);

    expect(getFeedbackThread).toHaveBeenCalledWith('did:plc:alice', 'one');
    expect(texts('.reply-body')).toEqual(['Landing in the next release.', 'Thanks!']);
    // Who answered is the point: a reply from the board's moderators says so.
    expect(texts('.mod')).toEqual(['Maintainer']);
    // A reply to a reply is indented rather than flattened into the same column.
    expect(document.body.querySelectorAll('.replies .nested')).toHaveLength(1);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');

    await click(toggle);
    expect(document.body.querySelector('.thread')).toBeNull();
    await click(toggle);
    // Still one fetch: what was already loaded is kept across a collapse.
    expect(getFeedbackThread).toHaveBeenCalledTimes(1);
  });

  it('offers a retry when the replies cannot be loaded', async () => {
    threadFails = true;
    await render();
    await click(document.body.querySelector('.reply-toggle') as HTMLElement);
    expect(document.body.textContent).toContain("Couldn't load the replies.");

    threadFails = false;
    await click(document.body.querySelector('.thread button') as HTMLElement);
    expect(texts('.reply-body')).toHaveLength(2);
  });

  it('opens the replies on the reader’s own posts without being asked', async () => {
    // You came back to see whether anyone answered you; pressing a disclosure to
    // find out is a step this page can take on its own.
    getFeedbackThread.mockClear();
    getFeedbackBoard.mockImplementationOnce(async () => ({
      ...structuredClone(board),
      posts: [
        ...structuredClone(board.posts),
        {
          ...structuredClone(board.posts[1]),
          uri: 'at://did:plc:reader/app.userinput.discussion/mine',
          author: { did: 'did:plc:reader', handle: 'reader.test', displayName: null, avatar: null },
          title: 'My own bug',
          replyCount: 1,
        },
      ],
    }));
    await render();
    // The board load opens them; the fetch it starts settles a tick later.
    await tick();
    flushSync();

    expect(getFeedbackThread).toHaveBeenCalledExactlyOnceWith('did:plc:reader', 'mine');
    expect(sectionTitles('.mine')).toEqual(['My own bug']);
    expect(texts('.mine .reply-body')).toEqual(['Landing in the next release.', 'Thanks!']);
    // The board's count included a reply this page filters out or upstream
    // has since lost; the loaded list is what the row now says.
    expect(document.body.querySelector('.mine .reply-toggle')?.textContent).toContain('2 replies');
  });

  it('pins the reader’s own posts above the board, newest first', async () => {
    const mine = {
      ...structuredClone(board.posts[1]),
      uri: 'at://did:plc:reader/app.userinput.discussion/mine',
      author: { did: 'did:plc:reader', handle: 'reader.test', displayName: null, avatar: null },
      title: 'My own bug',
      createdAt: '2026-09-04T12:00:00Z',
      votes: { up: 0, down: 0, net: 0 },
    };
    getFeedbackBoard.mockImplementationOnce(async () => ({
      ...structuredClone(board),
      posts: [...structuredClone(board.posts), mine],
    }));
    await render();

    expect(sectionTitles('.mine')).toEqual(['My own bug']);
    // And only there: the list below is everyone else's, and a duplicate row
    // would just be the same post twice.
    expect(texts('.posts:not(.mine .posts) .post h3')).toEqual([
      'Add focus mode',
      'Fix feed refresh',
      'An untagged wish',
    ]);
  });

  it('keeps the reader’s own settled post pinned under the open scope', async () => {
    // The notification saying a post was implemented links straight here, so
    // the page's own default filter must not be what hides it. The status pill
    // on the row says which state it is in; the scope is for browsing the board.
    const settled = {
      ...structuredClone(board.posts[1]),
      uri: 'at://did:plc:reader/app.userinput.discussion/mine',
      author: { did: 'did:plc:reader', handle: 'reader.test', displayName: null, avatar: null },
      title: 'My own bug',
      status: 'implemented',
    };
    getFeedbackBoard.mockImplementationOnce(async () => ({
      ...boardWithClosed(),
      posts: [...boardWithClosed().posts, settled],
    }));
    await render();

    expect(chip('Filter by status', 'Open').getAttribute('aria-pressed')).toBe('true');
    expect(sectionTitles('.mine')).toEqual(['My own bug']);
    // The board below it still answers the scope: only this reader's own short
    // list is exempt.
    expect(texts('.posts:not(.mine .posts) .post h3')).toEqual([
      'Add focus mode',
      'Fix feed refresh',
      'An untagged wish',
    ]);
  });

  it('still says the rest is closed when only the reader’s own post is open', async () => {
    // The pinned section above doesn't answer the scope, so the board's own
    // emptiness needs saying even when the page isn't blank.
    const mine = {
      ...structuredClone(board.posts[1]),
      uri: 'at://did:plc:reader/app.userinput.discussion/mine',
      author: { did: 'did:plc:reader', handle: 'reader.test', displayName: null, avatar: null },
      title: 'My own bug',
    };
    getFeedbackBoard.mockImplementationOnce(async () => ({
      ...boardWithClosed(),
      posts: [...boardWithClosed().posts.filter((post) => post.status === 'implemented'), mine],
    }));
    await render();

    expect(sectionTitles('.mine')).toEqual(['My own bug']);
    expect(document.body.textContent).toContain('Nothing open here.');
  });

  it('keeps a just-posted item through a reload, until the board carries it', async () => {
    await render();
    await submitPost('Sync highlights faster');

    // The board still can't return it — upstream aggregates by backlink — so the
    // reader's own copy is what survives the reload.
    await reload();
    expect(sectionTitles('.mine')).toEqual(['Sync highlights faster']);
    expect(document.body.textContent).toContain('Not on the board yet');

    // Once upstream indexes it, the remembered copy goes: one row, the real one.
    getFeedbackBoard.mockImplementationOnce(async () => ({
      ...structuredClone(board),
      posts: [
        ...structuredClone(board.posts),
        {
          ...structuredClone(board.posts[1]),
          uri: 'at://did:plc:reader/app.userinput.discussion/fresh',
          author: { did: 'did:plc:reader', handle: 'reader.test', displayName: null, avatar: null },
          title: 'Sync highlights faster',
          votes: { up: 1, down: 0, net: 1 },
          replyCount: 1,
        },
      ],
    }));
    await reload();
    expect(sectionTitles('.mine')).toEqual(['Sync highlights faster']);
    expect(document.body.textContent).not.toContain('Not on the board yet');
    expect(texts('.post h3').filter((title) => title === 'Sync highlights faster')).toHaveLength(1);
  });

  it('shows no vote on the new post when the self-upvote did not land', async () => {
    selfUpvoted = false;
    await render();
    await submitPost('Quieter notifications');

    // The board will show zero until someone votes; showing one here would be a
    // number that never arrives.
    expect(votes('Quieter notifications')).toBe('0 net votes');
  });

  it('files a post as a question unless the reader says otherwise', async () => {
    // A board with no vocabulary of its own gets the default three, which
    // include the type a post lands under when nobody picks.
    getFeedbackBoard.mockImplementationOnce(async () => ({
      ...structuredClone(board),
      types: [],
    }));
    await render();
    await openComposer();

    expect(checkedType()).toBe('question');
    // Nothing to choose first, so the button is live as soon as there's a title.
    await fillPost('Does the reader sync across devices?', '');
    expect(composerField<HTMLButtonElement>('button[type="submit"]').disabled).toBe(false);

    await submitForm();
    expect(createFeedbackPost).toHaveBeenCalledWith(
      expect.objectContaining({ tags: ['question'] })
    );
  });

  it('will not post without a type when the board offers no default', async () => {
    // This board's vocabulary is bug/feature, so there is no question to fall
    // back on and the composer has to ask.
    await render();
    await openComposer();
    await fillPost('A wish with no type', '');

    // The track offers the board's two types and starts on neither, so there is
    // no way to file a post under nothing.
    expect(typeRadios().map((radio) => radio.value)).toEqual(['bug', 'feature']);
    expect(checkedType()).toBeUndefined();
    expect(composerField<HTMLButtonElement>('button[type="submit"]').disabled).toBe(true);

    await submitForm();
    expect(createFeedbackPost).not.toHaveBeenCalled();

    await fillPost('A wish with no type', 'feature');
    await submitForm();
    expect(createFeedbackPost).toHaveBeenCalledWith(expect.objectContaining({ tags: ['feature'] }));
  });

  it('uploads an attachment and embeds it in the post', async () => {
    await render();
    await openComposer();
    await attach([png('reader.png')]);

    expect(uploadFeedbackImage).toHaveBeenCalledTimes(1);
    // The filename seeds the description, and is editable before posting.
    const alt = composerField<HTMLInputElement>('.alt');
    expect(alt.value).toBe('reader.png');
    alt.value = 'The clipped last line';
    alt.dispatchEvent(new Event('input', { bubbles: true }));
    flushSync();

    await fillPost('Reader crops the last line');
    await submitForm();
    expect(createFeedbackPost).toHaveBeenCalledWith(
      expect.objectContaining({
        images: [{ alt: 'The clipped last line', image: uploadedBlob }],
      })
    );
  });

  it('refuses a file the lexicon would, before uploading it', async () => {
    await render();
    await openComposer();
    const huge = png('screenshot.png', 1_000_001);
    const wrongType = new File(['x'], 'notes.pdf', { type: 'application/pdf' });
    await attach([huge, wrongType]);

    expect(uploadFeedbackImage).not.toHaveBeenCalled();
    expect(document.body.querySelector('.composer .attachments')).toBeNull();
    expect(document.body.textContent).toContain('over 1 MB');
  });

  it('holds the post until every attachment has landed, and keeps a failure visible', async () => {
    uploadFails = 'error';
    await render();
    await openComposer();
    await attach([png('reader.png')]);
    await fillPost('Reader crops the last line');

    // The failed one stays on screen rather than being dropped from the post.
    expect(document.body.textContent).toContain('Upload failed');
    await submitForm();
    expect(createFeedbackPost).toHaveBeenCalledWith(
      expect.not.objectContaining({ images: expect.anything() })
    );
  });

  it('hides the attach control when the session cannot upload blobs', async () => {
    scopeStatus = { semble: false, margin: false, userinput: true, userinputImages: false };
    await render();
    await openComposer();
    expect(document.body.querySelector('.composer .file-input')).toBeNull();
  });

  it('offers a re-login instead of a composer when the session lacks the scope', async () => {
    scopeStatus = { semble: false, margin: false, userinput: false };
    await render();
    expect(texts('button.link')).toEqual(['Log in again']);
    expect(document.body.querySelector('.composer')).toBeNull();
    expect(document.body.textContent).toContain('post on userinput.app');
  });
});
