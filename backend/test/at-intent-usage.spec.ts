import { describe, it, expect, vi, afterEach } from 'vitest';
import * as pdsClient from '../src/services/pds-client';
import { writeUsageRecord } from '../src/services/at-intent-usage';
import { AT_INTENT_SCOPES } from '../src/config/scopes';
import type { Session } from '../src/types';

const APP_DID = 'did:plc:ra4jsemddo2ii4pn5jaf6x4v';
const USAGE_COLLECTION = 'dev.at-intent.usage';

function session(grantedScopes: string): Session {
  return {
    did: 'did:plc:user',
    handle: 'user.bsky.social',
    pdsUrl: 'https://pds.test',
    accessToken: 'tok',
    refreshToken: 'rtok',
    dpopPrivateKey: JSON.stringify({ kty: 'EC' }),
    expiresAt: Date.now() + 3_600_000,
    grantedScopes,
  } as Session;
}

// A fake PDSClient exposing only the methods writeUsageRecord touches.
function fakeClient(records: Array<{ uri: string; value: unknown }>) {
  const putRecord = vi.fn().mockResolvedValue({ success: true, data: { uri: 'at://x', cid: 'c' } });
  const listRecords = vi.fn().mockResolvedValue({ success: true, data: { records } });
  return { client: { listRecords, putRecord } as any, putRecord, listRecords };
}

afterEach(() => vi.restoreAllMocks());

describe('writeUsageRecord', () => {
  it('skips entirely when the usage scope was not granted', async () => {
    const spy = vi.spyOn(pdsClient, 'createPDSClient');
    await writeUsageRecord(session('atproto repo:app.skyreader.feed.subscription'));
    expect(spy).not.toHaveBeenCalled();
  });

  it('creates a new record (fresh TID rkey) pointing at the app DID when none exists', async () => {
    const { client, putRecord, listRecords } = fakeClient([]);
    vi.spyOn(pdsClient, 'createPDSClient').mockReturnValue(client);

    await writeUsageRecord(session(AT_INTENT_SCOPES[0]));

    expect(listRecords).toHaveBeenCalledWith(USAGE_COLLECTION);
    expect(putRecord).toHaveBeenCalledTimes(1);
    const [collection, rkey, record] = putRecord.mock.calls[0];
    expect(collection).toBe(USAGE_COLLECTION);
    expect(rkey).toMatch(/^[a-z0-9]{13,}$/); // a freshly minted TID
    expect(record.app).toBe(APP_DID);
    expect(record.$type).toBe(USAGE_COLLECTION);
    expect(record.createdAt).toBe(record.lastSeenAt); // first write: created == lastSeen
  });

  it('reuses the existing rkey and preserves createdAt, bumping only lastSeenAt', async () => {
    const existingCreatedAt = '2026-01-01T00:00:00.000Z';
    const { client, putRecord } = fakeClient([
      {
        uri: `at://did:plc:user/${USAGE_COLLECTION}/existingrkey01`,
        value: { app: APP_DID, createdAt: existingCreatedAt, lastSeenAt: existingCreatedAt },
      },
    ]);
    vi.spyOn(pdsClient, 'createPDSClient').mockReturnValue(client);

    await writeUsageRecord(session(AT_INTENT_SCOPES[0]));

    const [, rkey, record] = putRecord.mock.calls[0];
    expect(rkey).toBe('existingrkey01');
    expect(record.createdAt).toBe(existingCreatedAt);
    expect(record.lastSeenAt).not.toBe(existingCreatedAt); // bumped to now
  });

  it('ignores usage records for other apps when deduping', async () => {
    const { client, putRecord } = fakeClient([
      {
        uri: `at://did:plc:user/${USAGE_COLLECTION}/otherapp01`,
        value: { app: 'did:web:someother.app', createdAt: '2026-01-01T00:00:00.000Z' },
      },
    ]);
    vi.spyOn(pdsClient, 'createPDSClient').mockReturnValue(client);

    await writeUsageRecord(session(AT_INTENT_SCOPES[0]));

    const [, rkey, record] = putRecord.mock.calls[0];
    expect(rkey).not.toBe('otherapp01'); // minted a fresh one, didn't clobber the other app
    expect(rkey).toMatch(/^[a-z0-9]{13,}$/);
    expect(record.app).toBe(APP_DID);
  });
});
