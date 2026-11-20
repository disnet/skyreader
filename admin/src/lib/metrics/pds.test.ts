import { describe, it, expect } from 'vitest';
import {
  differsFromReference,
  nonceSignal,
  notFoundWording,
  pdsGroup,
  rateLimitHeaders,
  summarizePdsHosts,
  type PdsTraitsRow,
} from './pds';

function traits(host: string, counts: Partial<PdsTraitsRow> = {}): PdsTraitsRow {
  return {
    host,
    first_seen_at: 100,
    last_seen_at: 200,
    writes_ok: 0,
    writes_ok_rate_limit_headers: 0,
    writes_refused: 0,
    writes_refused_rate_limit_headers: 0,
    writes_refused_retry_after: 0,
    nonce_in_body: 0,
    nonce_header_only: 0,
    not_found_reference_message: 0,
    not_found_other_message: 0,
    server: null,
    ...counts,
  };
}

describe('pdsGroup', () => {
  it("puts Bluesky's PDS hosts in one row and leaves others alone", () => {
    expect(pdsGroup('morel.us-east.host.bsky.network')).toBe('Bluesky (*.host.bsky.network)');
    expect(pdsGroup('blacksky.app')).toBe('blacksky.app');
  });
});

describe('summarizePdsHosts', () => {
  it('merges readers and traits per group, most readers first', () => {
    const rows = summarizePdsHosts(
      [
        { pds_url: 'https://morel.us-east.host.bsky.network', readers: 5 },
        { pds_url: 'https://shiitake.us-east.host.bsky.network', readers: 3 },
        { pds_url: 'https://blacksky.app', readers: 2 },
        { pds_url: 'not a url', readers: 9 },
      ],
      [
        traits('morel.us-east.host.bsky.network', {
          writes_ok: 4,
          writes_ok_rate_limit_headers: 4,
        }),
        traits('blacksky.app', { writes_ok: 10, writes_refused: 1, server: 'rsky' }),
        traits('nobody.test', { writes_ok: 1 }),
      ]
    );
    expect(rows.map((r) => [r.name, r.hosts, r.readers, r.writes_ok])).toEqual([
      ['Bluesky (*.host.bsky.network)', 2, 8, 4],
      ['blacksky.app', 1, 2, 10],
      ['nobody.test', 1, 0, 1],
    ]);
    expect(rows[1].server).toBe('rsky');
  });
});

describe('trait words', () => {
  const base = traits('x');

  it('tells the reference rate-limit headers from rsky-like and none', () => {
    expect(rateLimitHeaders(base)).toBe('—');
    expect(rateLimitHeaders({ ...base, writes_ok: 10, writes_ok_rate_limit_headers: 10 })).toBe(
      'on every write'
    );
    expect(
      rateLimitHeaders({
        ...base,
        writes_ok: 10,
        writes_refused: 2,
        writes_refused_rate_limit_headers: 2,
      })
    ).toBe('only on a 429');
    expect(rateLimitHeaders({ ...base, writes_ok: 10, writes_refused: 2 })).toBe('never');
    expect(rateLimitHeaders({ ...base, writes_ok: 10 })).toBe('not on a write (no 429 seen)');
  });

  it('describes the nonce signal and not-found wording', () => {
    expect(nonceSignal({ ...base, nonce_in_body: 3 })).toBe('body + header');
    expect(nonceSignal({ ...base, nonce_header_only: 1 })).toBe('header only');
    expect(notFoundWording({ ...base, not_found_reference_message: 1 })).toBe('reference');
    expect(notFoundWording({ ...base, not_found_other_message: 1 })).toBe('its own');
  });

  it('flags a group that differs from the reference PDS', () => {
    expect(differsFromReference({ ...base, writes_ok: 3, writes_ok_rate_limit_headers: 3 })).toBe(
      false
    );
    expect(differsFromReference({ ...base, writes_ok: 3 })).toBe(true);
    expect(differsFromReference({ ...base, writes_ok: 10, writes_ok_rate_limit_headers: 5 })).toBe(
      true
    );
    expect(differsFromReference({ ...base, nonce_header_only: 1 })).toBe(true);
  });
});
