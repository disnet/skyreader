// The PDS-facing paths that broke, or could break, on a PDS that isn't Bluesky's,
// run against every profile in helpers/fake-pds.ts. Real code from PDSClient down:
// nothing between the feature and the (fake) PDS is mocked.
import { env } from 'cloudflare:test';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createPDSClient } from '../src/services/pds-client';
import { exportNativeSaves } from '../src/services/backing/enable';
import { ensureLinkblogPublication } from '../src/services/linkblog-sync';
import { editMemberships } from '../src/services/integration-membership';
import { FakePds, PDS_PROFILES } from './helpers/fake-pds';

const DID = 'did:plc:pdscompat';

async function resetDb() {
  for (const t of ['saved_articles', 'backed_collection_members', 'user_settings']) {
    await env.DB.prepare(`DELETE FROM ${t} WHERE user_did = ?`).bind(DID).run();
  }
  await env.DB.prepare(
    `INSERT INTO users (did, handle, pds_url, last_synced_at) VALUES (?, 'compat.test', 'https://fake-pds.test', 0)
     ON CONFLICT(did) DO NOTHING`
  )
    .bind(DID)
    .run();
}

async function seedSaves(n: number) {
  for (let i = 0; i < n; i++) {
    await env.DB.prepare(
      `INSERT INTO saved_articles (user_did, rkey, url, title, source, saved_at, created_at)
       VALUES (?, ?, ?, 'T', 'url', 100, 100)`
    )
      .bind(DID, `rk${i}`, `https://compat.test/${i}`)
      .run();
  }
}

describe.each(PDS_PROFILES)('on a $name PDS', (profile) => {
  let pds: FakePds;

  beforeEach(async () => {
    await resetDb();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  describe('PDSClient', () => {
    it('writes after the PDS asks for a DPoP nonce, and when it rotates one', async () => {
      pds = new FakePds(profile, { did: DID, rotateNonceEvery: 3 }).install();
      const client = createPDSClient(pds.session());
      for (let i = 0; i < 5; i++) {
        const res = await client.putRecord('app.test.thing', `rk${i}`, { i });
        expect(res.success, `write ${i}`).toBe(true);
      }
      expect(pds.records('app.test.thing').size).toBe(5);
    });

    it('reports a missing record as RecordNotFound', async () => {
      pds = new FakePds(profile, { did: DID }).install();
      const res = await createPDSClient(pds.session()).getRecord('app.test.thing', 'nope');
      expect(res.success).toBe(false);
      if (!res.success) expect(res.code).toBe('RecordNotFound');
    });

    it('a refused write always pauses the writer, whatever headers came with it', async () => {
      pds = new FakePds(profile, { did: DID, budget: { limit: 3, windowSeconds: 3600 } }).install();
      const client = createPDSClient(pds.session());
      expect((await client.putRecord('app.test.thing', 'a', {})).success).toBe(true);
      const refused = await client.putRecord('app.test.thing', 'b', {});
      expect(refused).toMatchObject({ success: false, status: 429, retryable: true });
      expect(client.rateLimit?.remaining).toBe(0);
      expect(client.rateLimit!.resetAt).toBeGreaterThan(Date.now());
    });
  });

  describe.each(['semble', 'margin'] as const)('copying saves into a %s collection', (provider) => {
    const collection = provider === 'semble' ? 'network.cosmik.collection' : 'at.margin.collection';
    const linkCollection =
      provider === 'semble' ? 'network.cosmik.collectionLink' : 'at.margin.collectionItem';
    const itemCollection = provider === 'semble' ? 'network.cosmik.card' : 'at.margin.note';
    const backing = { provider, collectionUri: `at://${DID}/${collection}/col` };

    /** Copy 8 saves, starting a new rate-limit window whenever the copy pauses. */
    async function copyAcrossWindows() {
      // A budget of a few saves a window, so the copy runs into it: a Semble save
      // is two putRecords (4 points), a Margin one an applyWrites of two creates (6).
      // 22 leaves a Semble copy room for a card but not its link.
      pds = new FakePds(profile, { did: DID, budget: { limit: 22, windowSeconds: 3600 } });
      pds.install().seed(collection, 'col', { name: 'Saves' });
      const session = pds.session();
      await seedSaves(8);

      let afterId = 0;
      const failed: string[] = [];
      const pauses: number[] = [];
      for (let window = 0; window < 10; window++) {
        const res = await exportNativeSaves(env, session, backing, { afterId, limit: 100 });
        failed.push(...res.failed);
        afterId = res.lastId;
        if (res.retryAfter === undefined) break;
        pauses.push(res.retryAfter);
        pds.resetBudget();
      }
      const members = await env.DB.prepare(
        'SELECT COUNT(*) AS n FROM backed_collection_members WHERE user_did = ?'
      )
        .bind(DID)
        .first<{ n: number }>();
      return {
        failed,
        pauses,
        members: members?.n,
        links: pds.records(linkCollection).size,
        items: pds.records(itemCollection).size,
        refusals: pds.calls.filter((c) => c.status === 429).length,
      };
    }

    it('copies every save exactly once across rate-limit windows', async () => {
      const run = await copyAcrossWindows();
      expect(run.failed, 'no save is given up on for the rate limit').toEqual([]);
      expect(run.pauses.length).toBeGreaterThan(0);
      for (const p of run.pauses) expect(p).toBeGreaterThan(0);
      expect(run.links).toBe(8);
      expect(run.members).toBe(8);
      // Where the PDS says what's left, the copy stops before it's refused.
      if (profile.rateLimitHeaders === 'always') expect(run.refusals).toBe(0);
    });

    // KNOWN GAP: a Semble copy writes the card, then the link. When the link is
    // refused for the rate limit, the card's cleanup delete is refused too, and
    // the retry writes a second card. A PDS that reports its budget stops the
    // copy before that; one that doesn't (rsky) leaves a stray card per refusal.
    // This pins the stray cards, so the fix turns it red: then expect 8 everywhere.
    const strayCards = provider === 'semble' && profile.rateLimitHeaders !== 'always';
    it(strayCards ? 'leaves stray cards (known gap)' : 'leaves no stray items behind', async () => {
      const run = await copyAcrossWindows();
      expect(run.links).toBe(8);
      if (strayCards) expect(run.items).toBeGreaterThan(8);
      else expect(run.items).toBe(8);
    });
  });

  describe('linkblog', () => {
    it("creates the publication on a reader's first share", async () => {
      pds = new FakePds(profile, { did: DID }).install();
      const res = await ensureLinkblogPublication(pds.session(), env);
      expect(res).toMatchObject({ success: true, data: { created: true } });
      expect(pds.records('site.standard.publication').size).toBe(1);
      // And finds it the second time.
      const again = await ensureLinkblogPublication(pds.session(), env);
      expect(again).toMatchObject({ success: true, data: { created: false } });
    });
  });

  describe('collection membership', () => {
    it('removing a link that is already gone counts as removed', async () => {
      pds = new FakePds(profile, { did: DID }).install();
      const res = await editMemberships(createPDSClient(pds.session()), DID, 'semble', {
        url: 'https://compat.test/a',
        add: [],
        remove: [`at://${DID}/network.cosmik.collectionLink/3gone0000000a`],
      });
      expect(res.removed).toEqual([
        { linkUri: `at://${DID}/network.cosmik.collectionLink/3gone0000000a` },
      ]);
    });
  });
});
