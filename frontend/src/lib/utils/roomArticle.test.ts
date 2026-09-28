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

const { articleForReader } = await import('./roomArticle');

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
