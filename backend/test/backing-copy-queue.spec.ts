import { env } from 'cloudflare:test';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  queueBackingCopy,
  runBackingCopy,
  backingCopyStatus,
  restartStaleBackingCopies,
} from '../src/services/backing/copy-queue';
import { disableBacking } from '../src/services/backing/enable';
import { PDSClient, type PdsRateLimit } from '../src/services/pds-client';
import * as write from '../src/services/backing/write';
import * as oauth from '../src/services/oauth';
import type { Session } from '../src/types';

const DID = 'did:plc:copyqueue';
const COLLECTION = `at://${DID}/at.margin.collection/col1`;
const session = { did: DID, pdsUrl: 'https://pds.test' } as unknown as Session;

let sent: { body: { type: string; did: string; token: string }; delaySeconds?: number }[];

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
    await runBackingCopy(env, { did: DID, token: 'someone-else' });
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
});
