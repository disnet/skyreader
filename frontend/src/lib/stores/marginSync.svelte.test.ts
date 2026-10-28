import { beforeEach, describe, expect, it } from 'vitest';
import { marginSyncStore } from './marginSync.svelte';

describe('marginSyncStore', () => {
  beforeEach(() => localStorage.clear());

  it('remembers when a sync finished, per account', () => {
    marginSyncStore.started();
    expect(marginSyncStore.syncing).toBe(true);
    marginSyncStore.finished('did:plc:a', { truncated: false });
    expect(marginSyncStore.syncing).toBe(false);
    expect(marginSyncStore.lastSyncedAt('did:plc:a')).toBeTypeOf('number');
    expect(marginSyncStore.lastSyncedAt('did:plc:b')).toBeNull();
  });

  it('keeps the last good time when a sync fails', () => {
    marginSyncStore.finished('did:plc:a', { truncated: true });
    const at = marginSyncStore.lastSyncedAt('did:plc:a');
    marginSyncStore.started();
    marginSyncStore.finished('did:plc:a', null);
    expect(marginSyncStore.lastSyncedAt('did:plc:a')).toBe(at);
    expect(marginSyncStore.truncated).toBe(true);
  });

  it('says the grant lapsed until the reader acts on it, or a sync succeeds', () => {
    marginSyncStore.markLapsed();
    expect(marginSyncStore.lapsed).toBe(true);
    marginSyncStore.clearLapsed();
    expect(marginSyncStore.lapsed).toBe(false);
    marginSyncStore.markLapsed();
    marginSyncStore.finished('did:plc:a', { truncated: false });
    expect(marginSyncStore.lapsed).toBe(false);
  });
});
