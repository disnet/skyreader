import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount, tick } from 'svelte';

// The page's whole job is to make a third party's board legible: group posts by
// type, filter by type and status, and let a reader post without leaving. These
// mount it against a stubbed API so each of those is checked in a real DOM.

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

let scopeStatus: Record<string, boolean> = { semble: false, margin: false, userinput: true };
const getFeedbackBoard = vi.fn(async () => structuredClone(board));
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

vi.mock('$lib/services/api', () => ({
  api: {
    getFeedbackBoard: () => getFeedbackBoard(),
    getIntegrationStatus: vi.fn(async () => ({ scopeStatus })),
    createFeedbackPost: (input: { title: string; body?: string }) => createFeedbackPost(input),
  },
  ScopeUpgradeError: FakeScopeUpgradeError,
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

function button(group: string, label: string): HTMLButtonElement {
  const scope = document.body.querySelector(`[aria-label="${group}"]`);
  const found = [...(scope?.querySelectorAll('button') ?? [])].find(
    (candidate) => candidate.textContent?.trim() === label
  );
  if (!found) throw new Error(`no "${label}" button under ${group}`);
  return found;
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

async function submitPost(title: string) {
  await click(document.body.querySelector('.post-link') as HTMLElement);
  const field = document.body.querySelector<HTMLInputElement>('.composer input')!;
  field.value = title;
  field.dispatchEvent(new Event('input', { bubbles: true }));
  const type = document.body.querySelector<HTMLSelectElement>('.composer select')!;
  type.value = 'bug';
  type.dispatchEvent(new Event('change', { bubbles: true }));
  flushSync();

  document.body.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true }));
  await tick();
  await tick();
  flushSync();
}

beforeEach(() => {
  scopeStatus = { semble: false, margin: false, userinput: true };
  selfUpvoted = true;
  getFeedbackBoard.mockClear();
  createFeedbackPost.mockClear();
});

afterEach(() => {
  if (component) unmount(component);
  component = undefined;
  document.body.innerHTML = '';
});

describe('the feedback board', () => {
  it('groups posts by type, with untyped posts last', async () => {
    await render();
    expect(texts('.group-heading')).toEqual(['Bug 1', 'Feature request 1', 'Other 1']);
  });

  it('filters by type, and drops the group headings while filtered', async () => {
    await render();
    await click(button('Filter by type', 'Bug'));
    expect(texts('.post h3')).toEqual(['Fix feed refresh']);
    expect(texts('.group-heading')).toEqual([]);

    await click(button('Filter by type', 'All'));
    expect(texts('.post h3')).toHaveLength(3);
  });

  it('filters by status, counting an untriaged post as open', async () => {
    await render();
    await click(button('Filter by status', 'Planned'));
    expect(texts('.post h3')).toEqual(['Add focus mode']);

    await click(button('Filter by status', 'Open'));
    expect(texts('.post h3')).toEqual(['Fix feed refresh', 'An untagged wish']);
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

  it('shows no vote on the new post when the self-upvote did not land', async () => {
    selfUpvoted = false;
    await render();
    await submitPost('Quieter notifications');

    // The board will show zero until someone votes; showing one here would be a
    // number that never arrives.
    expect(votes('Quieter notifications')).toBe('0 net votes');
  });

  it('offers a re-login instead of a composer when the session lacks the scope', async () => {
    scopeStatus = { semble: false, margin: false, userinput: false };
    await render();
    expect(texts('button.link')).toEqual(['Log in again']);
    expect(document.body.querySelector('.composer')).toBeNull();
    expect(document.body.textContent).toContain('post on userinput.app');
  });
});
