import { beforeEach, describe, expect, it, vi } from 'vitest';

const fetchDocumentV2 = vi.fn();
vi.mock('$lib/services/api', () => ({
  api: { fetchDocumentV2: (uri: string) => fetchDocumentV2(uri) },
}));

const { documentBody } = await import('./documentBody');

const doc = (over: Record<string, unknown>) => ({
  recordUri: 'at://did:plc:a/site.standard.document/1',
  authorDid: 'did:plc:a',
  title: 'A proposal',
  description: 'The working explainer.',
  ...over,
});

describe('documentBody', () => {
  beforeEach(() => fetchDocumentV2.mockReset());

  it("renders the record's text", async () => {
    fetchDocumentV2.mockResolvedValueOnce(
      doc({
        recordUri: 'at://did:plc:a/site.standard.document/2',
        textContent: 'The whole proposal.',
      })
    );
    expect(await documentBody('at://did:plc:a/site.standard.document/2')).toContain(
      'The whole proposal.'
    );
  });

  it('has nothing to keep for a record with only a description', async () => {
    fetchDocumentV2.mockResolvedValueOnce(
      doc({ recordUri: 'at://did:plc:a/site.standard.document/3' })
    );
    expect(await documentBody('at://did:plc:a/site.standard.document/3')).toBeNull();
  });

  it('refuses a stub whose structured body renders empty', async () => {
    const uri = 'at://did:plc:a/site.standard.document/5';
    fetchDocumentV2.mockResolvedValueOnce(
      doc({ recordUri: uri, content: { $type: 'pub.leaflet.content', pages: [] } })
    );
    expect(await documentBody(uri)).toBeNull();
  });

  it('answers null when the record cannot be fetched, or the guid is no record', async () => {
    fetchDocumentV2.mockRejectedValueOnce(new Error('502'));
    expect(await documentBody('at://did:plc:a/site.standard.document/4')).toBeNull();
    expect(await documentBody('https://example.com/post')).toBeNull();
    expect(fetchDocumentV2).toHaveBeenCalledTimes(1);
  });
});
