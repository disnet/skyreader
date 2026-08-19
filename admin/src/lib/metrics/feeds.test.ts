import { describe, it, expect } from 'vitest';
import { feedHealth } from './feeds';

describe('feedHealth', () => {
  it('reports a feed the crawler cannot fetch as an error', () => {
    expect(feedHealth({ error_count: 4, crawl_stale: 0 })).toEqual({
      status: 'error',
      label: 'Erroring',
    });
  });

  it('reports a feed the crawler never reaches as a distinct warning', () => {
    // Not the same fault as erroring: nothing is failing, the crawler simply
    // isn't keeping up. One is fixed per feed, the other by adding capacity.
    expect(feedHealth({ error_count: 0, crawl_stale: 1 })).toEqual({
      status: 'warning',
      label: 'Not crawled',
    });
  });

  it('leads with the error when a feed is both erroring and starved', () => {
    expect(feedHealth({ error_count: 2, crawl_stale: 1 }).label).toBe('Erroring');
  });

  it('calls a quiet feed healthy', () => {
    // The regression this replaced: a feed that simply hasn't published is fine,
    // and `last_ingest_at` deliberately plays no part in the verdict.
    expect(feedHealth({ error_count: 0, crawl_stale: 0 })).toEqual({
      status: 'healthy',
      label: 'OK',
    });
  });
});
