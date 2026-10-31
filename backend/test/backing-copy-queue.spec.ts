import { env } from 'cloudflare:test';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  queueBackingCopy,
  runBackingCopy,
  backingCopyStatus,
  restartStaleBackingCopies,
  resumeStalledBackingCopy,
  pauseBackingCopy,
  resumeBackingCopy,
  uncopiedSaves,
} from '../src/services/backing/copy-queue';
import { disableBacking } from '../src/services/backing/enable';
import { PDSClient, type PdsRateLimit } from '../src/services/pds-client';
import * as write from '../src/services/backing/write';
import * as oauth from '../src/services/oauth';
import type { Session } from '../src/types';

const DID = 'did:plc:copyqueue';
const COLLECTION = `at://${DID}/at.margin.collection/col1`;
const session = { did: DID, pdsUrl: 'https://pds.test' } as unknown as Session;

let sent: {
  body: { type: string; did: string; token: string; seq: number };
  delaySeconds?: number;
}[];

async function seedSaves(n: number) {
  for (let i = 0; i < n; i++) {
    await env.DB.prepare(
      `INSERT INTO saved_articles (user_did, rkey, url, source, saved_at, created_at)
       VALUES (?, ?, ?, 'url', 100, 100)`
    )
      .bind(DID, `rk${String(i).padStart(3, '0')}`, `https://a.test/${i}`)
      .run();
  }
}

async function pending(): Promise<number> {
  const row = await env.DB.prepare(
    'SELECT COUNT(*) AS n FROM backing_copy_pending WHERE user_did = ?'
  )
    .bind(DID)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

async function members(): Promise<number> {
  const row = await env.DB.prepare(
    'SELECT COUNT(*) AS n FROM backed_collection_members WHERE user_did = ?'
  )
    .bind(DID)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

/** Run the chain's queued hops until it stops queueing (or `max` hops). */
async function drain(max = 20) {
  for (let i = 0; i < max && sent.length > 0; i++) {
    const { body } = sent.shift()!;
    await runBackingCopy(env, body);
  }
}

beforeEach(async () => {
  for (const t of [
    'saved_articles',
    'backed_collection_members',
    'backing_copy_pending',
    'backing_copy_runs',
    'user_settings',
  ]) {
    await env.DB.prepare(`DELETE FROM ${t} WHERE user_did = ?`).bind(DID).run();
  }
  await env.DB.prepare(
    `INSERT INTO users (did, handle, pds_url, last_synced_at) VALUES (?, 'copy.test', 'https://pds.test', 0)
     ON CONFLICT(did) DO NOTHING`
  )
    .bind(DID)
    .run();
  await env.DB.prepare(`INSERT INTO user_settings (user_did, backing) VALUES (?, ?)`)
    .bind(DID, `margin:${COLLECTION}`)
    .run();
  sent = [];
  vi.spyOn(env.JOBS, 'sendBatch').mockImplementation(async (messages, opts) => {
    for (const m of messages) {
      sent.push({
        body: m.body as (typeof sent)[number]['body'],
        delaySeconds: opts?.delaySeconds,
      });
    }
  });
  vi.spyOn(oauth, 'getBackgroundSession').mockResolvedValue(session);
  let n = 0;
  vi.spyOn(write, 'createMember').mockImplementation(async () => {
    n++;
    return {
      itemUri: `at://${DID}/at.margin.note/n${n}`,
      linkUri: `at://${DID}/at.margin.collectionItem/i${n}`,
    };
  });
});

describe('background copy into the backing collection', () => {
  it("copies an import's saves a chunk per hop, then ends the chain", async () => {
    await seedSaves(30);
    const rkeys = Array.from({ length: 30 }, (_, i) => `rk${String(i).padStart(3, '0')}`);
    await queueBackingCopy(env, DID, rkeys);
    expect(await pending()).toBe(30);
    expect(sent).toHaveLength(1);

    await drain();
    expect(await members()).toBe(30);
    expect(await pending()).toBe(0);
    expect(await backingCopyStatus(env, DID)).toBeNull();
    const run = await env.DB.prepare('SELECT 1 FROM backing_copy_runs WHERE user_did = ?')
      .bind(DID)
      .first();
    expect(run).toBeNull();
  });

  it('a second queue while a chain runs adds to it rather than starting another', async () => {
    await seedSaves(4);
    await queueBackingCopy(env, DID, ['rk000', 'rk001']);
    await queueBackingCopy(env, DID, ['rk002', 'rk003']);
    expect(sent).toHaveLength(1);
    await drain();
    expect(await members()).toBe(4);
  });

  it('waits out the PDS write limit on the queue, keeping what it has not copied', async () => {
    await seedSaves(3);
    let budget: PdsRateLimit | null = null;
    vi.spyOn(PDSClient.prototype, 'rateLimit', 'get').mockImplementation(() => budget);
    vi.mocked(write.createMember).mockImplementation(async () => {
      budget = { limit: 100, remaining: 10, resetAt: Date.now() + 3_600_000 };
      return { itemUri: 'at://x/at.margin.note/n', linkUri: 'at://x/at.margin.collectionItem/i' };
    });
    await queueBackingCopy(env, DID, 'library');
    await runBackingCopy(env, sent.shift()!.body);

    expect(await pending()).toBe(2);
    expect(sent).toHaveLength(1);
    expect(sent[0].delaySeconds).toBeGreaterThan(3500);
    const status = await backingCopyStatus(env, DID);
    expect(status?.pending).toBe(2);
    expect(status?.resumesAt).toBeGreaterThan(Date.now());
  });

  it('a hop from a replaced chain does nothing', async () => {
    await seedSaves(1);
    await queueBackingCopy(env, DID, ['rk000']);
    await runBackingCopy(env, { did: DID, token: 'someone-else', seq: 0 });
    expect(await members()).toBe(0);
    expect(await pending()).toBe(1);
  });

  it('turning backing off drops the copy', async () => {
    await seedSaves(2);
    await queueBackingCopy(env, DID, 'library');
    await disableBacking(env, session);
    await drain();
    expect(await members()).toBe(0);
    expect(await pending()).toBe(0);
  });

  it('the cron starts again a chain that went quiet', async () => {
    await seedSaves(1);
    await queueBackingCopy(env, DID, ['rk000']);
    sent = []; // the message was lost, and its hop is long overdue
    await env.DB.prepare('UPDATE backing_copy_runs SET next_run_at = ? WHERE user_did = ?')
      .bind(Date.now() - 16 * 60_000, DID)
      .run();
    expect(await restartStaleBackingCopies(env)).toBe(1);
    await drain();
    expect(await members()).toBe(1);
  });

  it('a second delivery of the same hop does nothing, so no save is copied twice', async () => {
    await seedSaves(30);
    await queueBackingCopy(env, DID, 'library');
    const first = sent.shift()!.body;
    await Promise.all([runBackingCopy(env, first), runBackingCopy(env, first)]);
    expect(vi.mocked(write.createMember)).toHaveBeenCalledTimes(25);
    expect(sent).toHaveLength(1);
    await drain();
    expect(vi.mocked(write.createMember)).toHaveBeenCalledTimes(30);
  });

  it('a PDS refusing every copy keeps the queue and backs off, then stops', async () => {
    await seedSaves(30);
    vi.mocked(write.createMember).mockRejectedValue(new Error('PDS 502'));
    await queueBackingCopy(env, DID, 'library');
    await runBackingCopy(env, sent.shift()!.body);
    expect(await pending()).toBe(30);
    expect(sent[0].delaySeconds).toBe(15 * 60);

    for (let i = 0; i < 11; i++) {
      // Each hop runs once its wait is up.
      const { body } = sent.shift()!;
      await env.DB.prepare('UPDATE backing_copy_runs SET next_run_at = 0 WHERE user_did = ?')
        .bind(DID)
        .run();
      await runBackingCopy(env, body);
    }
    expect(sent).toHaveLength(0);
    expect(await pending()).toBe(30);
    expect(await backingCopyStatus(env, DID)).toMatchObject({ stalled: true, pending: 30 });
    // Nor does the cron restart a stopped copy.
    await env.DB.prepare('UPDATE backing_copy_runs SET next_run_at = 0 WHERE user_did = ?')
      .bind(DID)
      .run();
    expect(await restartStaleBackingCopies(env)).toBe(0);

    // The reader opening Settings gives it another go.
    vi.mocked(write.createMember).mockResolvedValue({
      itemUri: 'at://x/at.margin.note/n',
      linkUri: 'at://x/at.margin.collectionItem/i',
    });
    await resumeStalledBackingCopy(env, DID);
    await drain();
    expect(await pending()).toBe(0);
  });

  it('signed out: backs off rather than throwing to the queue', async () => {
    await seedSaves(2);
    vi.mocked(oauth.getBackgroundSession).mockResolvedValue(null);
    await queueBackingCopy(env, DID, 'library');
    await runBackingCopy(env, sent.shift()!.body);
    expect(await pending()).toBe(2);
    expect(sent).toHaveLength(1);
    expect(sent[0].delaySeconds).toBe(15 * 60);
  });

  it('a save that keeps failing while others copy is dropped after a few tries', async () => {
    await seedSaves(3);
    vi.mocked(write.createMember).mockImplementation(async (_pds, _did, _p, _c, input) => {
      if (input.url === 'https://a.test/1') throw new Error('bad record');
      return { itemUri: 'at://x/at.margin.note/n', linkUri: 'at://x/at.margin.collectionItem/i' };
    });
    await queueBackingCopy(env, DID, 'library');
    await drain();
    expect(await pending()).toBe(0);
    expect(
      vi.mocked(write.createMember).mock.calls.filter((c) => c[4].url === 'https://a.test/1')
    ).toHaveLength(3);
  });

  it('switching to another collection drops a copy queued for the old one', async () => {
    await seedSaves(2);
    await queueBackingCopy(env, DID, 'library');
    const res = await env.DB.prepare(
      'SELECT COUNT(*) AS n FROM backing_copy_runs WHERE user_did = ?'
    )
      .bind(DID)
      .first<{ n: number }>();
    expect(res?.n).toBe(1);
    const { clearBackingCopy } = await import('../src/services/backing/enable');
    await env.DB.batch(clearBackingCopy(env, DID));
    await drain();
    expect(await members()).toBe(0);
  });

  it('pausing keeps the queue and stops the chain; resuming carries on', async () => {
    await seedSaves(30);
    await queueBackingCopy(env, DID, 'library');
    await runBackingCopy(env, sent.shift()!.body);
    expect(await members()).toBe(25);

    await pauseBackingCopy(env, DID);
    await drain(); // the hop queued before the pause stops at its claim
    expect(await members()).toBe(25);
    expect(await backingCopyStatus(env, DID)).toMatchObject({
      pending: 5,
      paused: true,
      resumesAt: null,
    });

    // Neither the cron nor a new import restarts a paused copy.
    await env.DB.prepare('UPDATE backing_copy_runs SET next_run_at = 0 WHERE user_did = ?')
      .bind(DID)
      .run();
    expect(await restartStaleBackingCopies(env)).toBe(0);
    await queueBackingCopy(env, DID, ['rk000']);
    expect(sent).toHaveLength(0);

    await resumeBackingCopy(env, DID);
    await drain();
    expect(await members()).toBe(30);
    expect(await backingCopyStatus(env, DID)).toBeNull();
  });

  it('a hop mid-copy when paused finishes its chunk without copying it again on resume', async () => {
    await seedSaves(3);
    await queueBackingCopy(env, DID, 'library');
    vi.mocked(write.createMember).mockImplementationOnce(async () => {
      await pauseBackingCopy(env, DID);
      return { itemUri: 'at://x/at.margin.note/a', linkUri: 'at://x/at.margin.collectionItem/a' };
    });
    await runBackingCopy(env, sent.shift()!.body);
    expect(vi.mocked(write.createMember)).toHaveBeenCalledTimes(3);
    await resumeBackingCopy(env, DID);
    await drain();
    expect(vi.mocked(write.createMember)).toHaveBeenCalledTimes(3);
    expect(await pending()).toBe(0);
  });

  it('pausing and resuming mid-hop leaves one chain, copying nothing twice', async () => {
    await seedSaves(30);
    await queueBackingCopy(env, DID, 'library');
    vi.mocked(write.createMember).mockImplementationOnce(async () => {
      await pauseBackingCopy(env, DID);
      await resumeBackingCopy(env, DID);
      return { itemUri: 'at://x/at.margin.note/a', linkUri: 'at://x/at.margin.collectionItem/a' };
    });
    await runBackingCopy(env, sent.shift()!.body);
    // The resume's hop waits out the hop that was still copying.
    expect(sent[0].delaySeconds).toBeGreaterThanOrEqual(14 * 60);
    expect(await pending()).toBe(5);
    await drain();
    expect(vi.mocked(write.createMember)).toHaveBeenCalledTimes(30);
    expect(await backingCopyStatus(env, DID)).toBeNull();
  });

  it('resuming keeps a wait for the PDS write limit', async () => {
    await seedSaves(30);
    await queueBackingCopy(env, DID, 'library');
    const later = Date.now() + 2 * 60 * 60_000;
    await env.DB.prepare('UPDATE backing_copy_runs SET next_run_at = ? WHERE user_did = ?')
      .bind(later, DID)
      .run();
    sent = [];
    await pauseBackingCopy(env, DID);
    await resumeBackingCopy(env, DID);
    expect(sent[0].delaySeconds).toBeGreaterThan(110 * 60);
  });

  it('a stopped copy the reader pauses can be resumed', async () => {
    await seedSaves(3);
    await queueBackingCopy(env, DID, 'library');
    sent = [];
    await env.DB.prepare('UPDATE backing_copy_runs SET stalled = 1 WHERE user_did = ?')
      .bind(DID)
      .run();
    await pauseBackingCopy(env, DID);
    expect(await backingCopyStatus(env, DID)).toMatchObject({ paused: true, stalled: false });
    await resumeBackingCopy(env, DID);
    await drain();
    expect(await pending()).toBe(0);
  });

  it('counts the saves not yet in the collection, as the copy sees them', async () => {
    await seedSaves(3);
    // A second save of one page, and a link that can't be copied.
    await env.DB.prepare(
      `INSERT INTO saved_articles (user_did, rkey, url, source, saved_at, created_at)
       VALUES (?, 'dup', 'https://a.test/2', 'url', 100, 100),
              (?, 'odd', 'mailto:x@a.test', 'url', 100, 100)`
    )
      .bind(DID, DID)
      .run();
    expect(await uncopiedSaves(env, DID, COLLECTION)).toBe(3);
    await queueBackingCopy(env, DID, ['rk000']);
    await drain();
    expect(await uncopiedSaves(env, DID, COLLECTION)).toBe(2);
    // Members of another collection don't count as copied.
    expect(await uncopiedSaves(env, DID, `at://${DID}/at.margin.collection/other`)).toBe(3);
  });
});
