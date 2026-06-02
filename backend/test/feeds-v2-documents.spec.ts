import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { handleV2BatchDocumentFetch } from '../src/routes/feeds-v2';
import type { Env } from '../src/types';

const ENV = {
  FEED_PROXY_URL: 'https://proxy.example',
  FEED_PROXY_SECRET: 'test-secret',
} as Env;

const URL = 'https://api.example/api/v2/documents/batch';

function request(body: unknown, method = 'POST'): Request {
  return new Request(URL, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: method === 'POST' ? JSON.stringify(body) : undefined,
  });
}

function proxyResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('handleV2BatchDocumentFetch', () => {
  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('rejects non-POST requests', async () => {
    const res = await handleV2BatchDocumentFetch(request(undefined, 'GET'), ENV);
    expect(res.status).toBe(405);
  });

  it('rejects an invalid JSON body', async () => {
    const res = await handleV2BatchDocumentFetch(
      new Request(URL, { method: 'POST', body: 'not json' }),
      ENV
    );
    expect(res.status).toBe(400);
  });

  it('rejects a missing documents array', async () => {
    const res = await handleV2BatchDocumentFetch(request({}), ENV);
    expect(res.status).toBe(400);
  });

  it('rejects more than 50 authors', async () => {
    const documents = Array.from({ length: 51 }, (_, i) => ({
      did: `did:plc:${i}`,
    }));
    const res = await handleV2BatchDocumentFetch(request({ documents }), ENV);
    expect(res.status).toBe(400);
  });

  it('returns error entries for invalid DIDs without calling the proxy', async () => {
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock;

    const res = await handleV2BatchDocumentFetch(
      request({ documents: [{ did: 'not-a-did' }, { did: '' }] }),
      ENV
    );
    const json = (await res.json()) as {
      authors: Array<{ status: string; error?: string }>;
    };

    expect(res.status).toBe(200);
    expect(json.authors).toHaveLength(2);
    expect(json.authors.every((a) => a.status === 'error' && a.error === 'Invalid DID')).toBe(true);
    // No valid entries → the proxy is never contacted.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('forwards valid entries to the proxy and returns its authors', async () => {
    const proxyEntry = {
      did: 'did:plc:abc',
      siteUri: 'at://did:plc:abc/site.standard.publication/p',
      documents: [],
      status: 'ready' as const,
    };
    const fetchMock = vi.fn().mockResolvedValueOnce(proxyResponse({ authors: [proxyEntry] }));
    globalThis.fetch = fetchMock;

    const res = await handleV2BatchDocumentFetch(
      request({
        documents: [{ did: 'did:plc:abc', siteUri: proxyEntry.siteUri }],
      }),
      ENV
    );
    const json = (await res.json()) as { authors: unknown[] };

    expect(json.authors).toEqual([proxyEntry]);
    // Posts to the proxy's /documents endpoint.
    expect(String(fetchMock.mock.calls[0][0])).toBe('https://proxy.example/documents');
    expect(fetchMock.mock.calls[0][1].method).toBe('POST');
  });

  it('partitions invalid DIDs out and only forwards the valid ones', async () => {
    const okEntry = {
      did: 'did:plc:ok',
      documents: [],
      status: 'ready' as const,
    };
    const fetchMock = vi.fn().mockResolvedValueOnce(proxyResponse({ authors: [okEntry] }));
    globalThis.fetch = fetchMock;

    const res = await handleV2BatchDocumentFetch(
      request({ documents: [{ did: 'did:plc:ok' }, { did: 'garbage' }] }),
      ENV
    );
    const json = (await res.json()) as {
      authors: Array<{ did: string; status: string; error?: string }>;
    };

    // Only the valid DID was sent upstream.
    const sentBody = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(sentBody.authors).toEqual([{ did: 'did:plc:ok' }]);

    // Response carries both: the invalid error entry and the proxy's entry.
    expect(json.authors).toHaveLength(2);
    expect(json.authors.find((a) => a.did === 'garbage')?.error).toBe('Invalid DID');
    expect(json.authors.find((a) => a.did === 'did:plc:ok')?.status).toBe('ready');
  });

  it('surfaces a proxy failure as error entries for every valid author', async () => {
    // A proxy body without an `authors` array makes the client throw; the handler
    // should degrade each valid author to an error entry rather than 500.
    const fetchMock = vi.fn().mockResolvedValueOnce(proxyResponse({ error: 'boom' }));
    globalThis.fetch = fetchMock;

    const res = await handleV2BatchDocumentFetch(
      request({ documents: [{ did: 'did:plc:a' }, { did: 'did:plc:b' }] }),
      ENV
    );
    const json = (await res.json()) as {
      authors: Array<{ did: string; status: string; error?: string }>;
    };

    expect(res.status).toBe(200);
    expect(json.authors).toHaveLength(2);
    expect(json.authors.every((a) => a.status === 'error' && a.error === 'boom')).toBe(true);
  });
});
