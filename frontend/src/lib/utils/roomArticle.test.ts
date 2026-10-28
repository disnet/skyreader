import { beforeEach, describe, expect, it, vi } from 'vitest';

class FakeApiError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
    this.name = 'ApiError';
  }
}
class FakeExtractionBlockedError extends Error {
  name = 'ExtractionBlockedError';
}
class FakeOfflineError extends Error {
  name = 'OfflineError';
}
class FakeSessionExpiredError extends Error {
  name = 'SessionExpiredError';
}

const extract = vi.fn();
vi.mock('$lib/services/api', () => ({
  api: { extract: (...args: unknown[]) => extract(...args) },
  ApiError: FakeApiError,
  ExtractionBlockedError: FakeExtractionBlockedError,
  OfflineError: FakeOfflineError,
  SessionExpiredError: FakeSessionExpiredError,
}));

const reportClientError = vi.fn();
vi.mock('$lib/services/telemetry', () => ({
  reportClientError: (...args: unknown[]) => reportClientError(...args),
}));

vi.mock('$lib/constants/docs', () => ({
  docsUrl: (page: string) => `https://docs.skyreader.app/${page}/`,
}));

const getByUrl = vi.fn();
const getContent = vi.fn();
vi.mock('$lib/stores/saves.svelte', () => ({
  savesStore: {
    getByUrl: (url: string) => getByUrl(url),
    getContent: (rkey: string) => getContent(rkey),
  },
}));

const { articleForReader, roomArticleForReader } = await import('./roomArticle');
const { failedSaveBody } = await import('./saveAnywhere');

const ref = {
  url: 'https://www.example.com/essay',
  title: 'An essay',
  description: 'About reading',
  image: 'https://www.example.com/cover.png',
};

describe('articleForReader', () => {
  beforeEach(() => {
    extract.mockReset();
    reportClientError.mockReset();
  });

  it('opens the extracted article, unsaved', async () => {
    extract.mockResolvedValueOnce({
      title: 'Extracted title',
      author: 'A. Writer',
      description: null,
      content: '<p>Body</p>',
      domain: 'example.com',
      image: null,
      published: null,
      wordCount: 1,
    });

    const item = await articleForReader(ref);

    expect(item).toMatchObject({
      rkey: '',
      url: ref.url,
      title: 'Extracted title',
      author: 'A. Writer',
      description: 'About reading',
      image: ref.image,
      content: '<p>Body</p>',
      wordCount: 1,
    });
    expect(reportClientError).not.toHaveBeenCalled();
  });

  it('opens a note linking the page when the site blocks the fetcher, unreported', async () => {
    extract.mockRejectedValueOnce(new FakeExtractionBlockedError());

    const item = await articleForReader(ref);

    expect(item.rkey).toBe('');
    expect(item.title).toBe('An essay');
    expect(item.wordCount).toBeNull();
    expect(item.content).toContain('the site blocks automated readers');
    expect(item.content).toContain(
      '<a href="https://www.example.com/essay">Read it on example.com</a>'
    );
    expect(reportClientError).not.toHaveBeenCalled();
  });

  it('opens a note and reports an unexpected failure without the URL', async () => {
    extract.mockRejectedValueOnce(new FakeApiError('Failed to extract article', 502));

    const item = await articleForReader(ref);

    expect(item.content).toContain("Skyreader couldn't fetch this article.");
    expect(item.content).not.toContain('blocks automated readers');
    expect(reportClientError).toHaveBeenCalledTimes(1);
    const [kind, error] = reportClientError.mock.calls[0];
    expect(kind).toBe('article_open_failed');
    expect((error as Error).message).toBe('article open failed: ApiError 502');
    expect((error as Error).message).not.toContain('example.com');
  });

  it('reports an extraction that came back with no body', async () => {
    extract.mockResolvedValueOnce({ title: null, content: null });

    const item = await articleForReader(ref);

    expect(item.content).toContain('Read it on example.com');
    expect(reportClientError).toHaveBeenCalledWith('article_open_failed', expect.any(Error));
  });

  it('says so when offline, unreported', async () => {
    extract.mockRejectedValueOnce(new FakeOfflineError());

    const item = await articleForReader(ref);

    expect(item.content).toContain("You're offline");
    expect(reportClientError).not.toHaveBeenCalled();
  });

  it('does not report an expired session', async () => {
    extract.mockRejectedValueOnce(new FakeSessionExpiredError());

    const item = await articleForReader(ref);

    expect(item.content).toContain('Read it on example.com');
    expect(reportClientError).not.toHaveBeenCalled();
  });

  it('escapes the URL in the note', async () => {
    extract.mockRejectedValueOnce(new FakeExtractionBlockedError());

    const item = await articleForReader({ url: 'https://example.com/?q="><script>' });

    expect(item.content).not.toContain('<script>');
  });
});

describe('Bluesky post links', () => {
  const postUrl = 'https://bsky.app/profile/alice.example.com/post/3mabc123xyz22';

  beforeEach(() => {
    extract.mockReset();
    reportClientError.mockReset();
    vi.unstubAllGlobals();
  });

  it('opens a post as the embed the reader hydrates, without extracting', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ did: 'did:plc:alice' }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const item = await articleForReader({
      url: postUrl,
      title: 'Alice on Bluesky',
      image: 'https://bsky.app/static/social-card-default.png',
    });

    expect(extract).not.toHaveBeenCalled();
    expect(item.content).toContain('class="bsky-post-embed"');
    expect(item.content).toContain(
      'data-uri="at://did:plc:alice/app.bsky.feed.post/3mabc123xyz22"'
    );
    expect(item.content).toContain(`href="${postUrl}"`);
    expect(item.image).toBeNull();
    expect(item.title).toBe('Alice on Bluesky');
  });

  it('skips the handle lookup when the link already names a DID', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const item = await articleForReader({
      url: 'https://bsky.app/profile/did:plc:alice/post/3mabc123xyz22',
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(item.content).toContain(
      'data-uri="at://did:plc:alice/app.bsky.feed.post/3mabc123xyz22"'
    );
  });

  it('still links the post when the handle does not resolve', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 400 })));

    const item = await articleForReader({ url: postUrl });

    expect(item.content).not.toContain('bsky-post-embed');
    expect(item.content).toContain(`href="${postUrl}"`);
  });

  it('extracts other bsky.app pages as usual', async () => {
    extract.mockResolvedValueOnce({ content: '<p>Profile</p>' });

    const item = await articleForReader({ url: 'https://bsky.app/profile/alice.example.com' });

    expect(extract).toHaveBeenCalled();
    expect(item.content).toBe('<p>Profile</p>');
  });

  it('falls through to extraction on malformed percent-encoding', async () => {
    extract.mockResolvedValueOnce({ content: '<p>Page</p>' });

    const item = await articleForReader({ url: 'https://bsky.app/profile/%E0%A4%A/post/3mabc' });

    expect(extract).toHaveBeenCalled();
    expect(item.content).toBe('<p>Page</p>');
  });
});

describe('roomArticleForReader', () => {
  const save = { rkey: 'abc', uri: 'at://did:plc:me/app.skyreader.feed.saved/abc', url: ref.url };

  beforeEach(() => {
    extract.mockReset();
    getByUrl.mockReset();
    getContent.mockReset();
  });

  it('opens the save, under its own key, when it holds the text', async () => {
    getByUrl.mockReturnValueOnce(save);
    getContent.mockResolvedValueOnce('<p>The whole essay</p>');
    const opened = await roomArticleForReader(ref as never);
    expect(opened).toEqual({ type: 'saved', item: save, key: save.uri });
    expect(extract).not.toHaveBeenCalled();
  });

  it('extracts the article when it is not saved', async () => {
    extract.mockResolvedValueOnce({ content: '<p>Body</p>' });
    const opened = await roomArticleForReader(ref as never);
    expect(opened.key).toBe(ref.url);
    expect(opened.type === 'saved' && opened.item.rkey).toBe('');
    expect(opened.type === 'saved' && opened.item.content).toBe('<p>Body</p>');
  });

  it("extracts again when the save kept only the can't-fetch note", async () => {
    getByUrl.mockReturnValueOnce(save);
    getContent.mockResolvedValueOnce(failedSaveBody(ref.url, 'blocked'));
    extract.mockResolvedValueOnce({ content: '<p>Body</p>' });
    const opened = await roomArticleForReader(ref as never);
    expect(extract).toHaveBeenCalled();
    expect(opened.key).toBe(ref.url);
  });

  it('opens a saved Bluesky post as its embed, not the save', async () => {
    const post = { url: 'https://bsky.app/profile/did:plc:abc/post/3xyz' };
    getByUrl.mockReturnValue({ ...save, url: post.url });
    const opened = await roomArticleForReader(post as never);
    expect(opened.key).toBe(post.url);
    expect(opened.type === 'saved' && opened.item.content).toContain('bsky-post-embed');
    expect(getContent).not.toHaveBeenCalled();
  });

  it('extracts again when the save has no body', async () => {
    getByUrl.mockReturnValueOnce(save);
    getContent.mockResolvedValueOnce(null);
    extract.mockResolvedValueOnce({ content: '<p>Body</p>' });
    const opened = await roomArticleForReader(ref as never);
    expect(opened.key).toBe(ref.url);
  });
});
