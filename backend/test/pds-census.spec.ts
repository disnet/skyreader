import { env } from 'cloudflare:test';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createPDSClient } from '../src/services/pds-client';
import { flushPdsCensus, observePds, resetPdsCensus } from '../src/services/pds-census';
import { FakePds, REFERENCE, RSKY, SPEC_MINIMAL, type PdsProfile } from './helpers/fake-pds';

interface TraitsRow {
  writes_ok: number;
  writes_ok_rate_limit_headers: number;
  writes_refused: number;
  writes_refused_rate_limit_headers: number;
  writes_refused_retry_after: number;
  nonce_in_body: number;
  nonce_header_only: number;
  not_found_reference_message: number;
  not_found_other_message: number;
}

async function traitsOf(host: string): Promise<TraitsRow | null> {
  return env.DB.prepare('SELECT * FROM pds_host_traits WHERE host = ?')
    .bind(host)
    .first<TraitsRow>();
}

/** Two accepted writes, one refused, one missing record, then a forced flush. */
async function exercise(profile: PdsProfile, host: string): Promise<TraitsRow | null> {
  const pds = new FakePds(profile, {
    pdsUrl: `https://${host}`,
    budget: { limit: 4, windowSeconds: 3600 },
  }).install();
  const client = createPDSClient(pds.session());
  await client.putRecord('app.test.thing', 'a', {});
  await client.putRecord('app.test.thing', 'b', {});
  await client.putRecord('app.test.thing', 'c', {}); // refused: 4 points, 2 each
  await client.getRecord('app.test.thing', 'missing');
  await flushPdsCensus(env, true);
  return traitsOf(host);
}

describe('PDS census', () => {
  beforeEach(async () => {
    resetPdsCensus();
    await env.DB.prepare('DELETE FROM pds_host_traits').run();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it('records a reference PDS: headers on every write, the nonce in the body', async () => {
    expect(await exercise(REFERENCE, 'ref.test')).toMatchObject({
      writes_ok: 2,
      writes_ok_rate_limit_headers: 2,
      writes_refused: 1,
      writes_refused_rate_limit_headers: 1,
      nonce_in_body: 1,
      nonce_header_only: 0,
      not_found_reference_message: 1,
      not_found_other_message: 0,
    });
  });

  it('records an rsky-like PDS: headers only on the 429', async () => {
    expect(await exercise(RSKY, 'rsky.test')).toMatchObject({
      writes_ok: 2,
      writes_ok_rate_limit_headers: 0,
      writes_refused: 1,
      writes_refused_rate_limit_headers: 1,
      writes_refused_retry_after: 1,
    });
  });

  it('records a spec-minimal PDS: the nonce in the header, its own not-found wording', async () => {
    expect(await exercise(SPEC_MINIMAL, 'min.test')).toMatchObject({
      writes_ok_rate_limit_headers: 0,
      writes_refused_rate_limit_headers: 0,
      nonce_in_body: 0,
      nonce_header_only: 1,
      not_found_reference_message: 0,
      not_found_other_message: 1,
    });
  });

  it('adds to what earlier flushes recorded', async () => {
    observePds('https://add.test', { writeOk: true });
    await flushPdsCensus(env, true);
    observePds('https://add.test', { writeOk: true, rateLimitHeaders: true });
    await flushPdsCensus(env, true);
    expect(await traitsOf('add.test')).toMatchObject({
      writes_ok: 2,
      writes_ok_rate_limit_headers: 1,
    });
  });

  it('waits to flush until the tallies are due', async () => {
    const now = Date.now();
    observePds('https://due.test', { writeOk: true });
    await flushPdsCensus(env, false, now);
    expect(await traitsOf('due.test')).toBeNull();
    await flushPdsCensus(env, false, now + 61_000);
    expect(await traitsOf('due.test')).toMatchObject({ writes_ok: 1 });
  });
});
