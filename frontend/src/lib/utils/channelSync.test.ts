import { describe, it, expect } from 'vitest';
import { toConfig, fromRemote, computeSyncOperations, type RemoteChannel } from './channelSync';
import type { FilteredView } from '$lib/types';

function makeView(overrides: Partial<FilteredView> & { uuid: string }): FilteredView {
  return {
    id: 1,
    name: 'Test',
    readFilter: 'all',
    sortOrder: 'newest',
    createdAt: 1000,
    updatedAt: 1000,
    position: 0,
    ...overrides,
  };
}

function makeRemote(overrides: Partial<RemoteChannel> & { uuid: string }): RemoteChannel {
  return {
    name: 'Test',
    config: '{"readFilter":"all","sortOrder":"newest"}',
    position: 0,
    createdAt: 1000,
    updatedAt: 1000,
    ...overrides,
  };
}

describe('toConfig', () => {
  it('strips id, uuid, name, position, timestamps', () => {
    const view = makeView({
      uuid: 'a',
      sourceMode: 'all',
      typeFilter: ['rss'],
    });
    const config = toConfig(view);
    expect(config).not.toHaveProperty('id');
    expect(config).not.toHaveProperty('uuid');
    expect(config).not.toHaveProperty('name');
    expect(config).not.toHaveProperty('position');
    expect(config).not.toHaveProperty('createdAt');
    expect(config).not.toHaveProperty('updatedAt');
    expect(config.readFilter).toBe('all');
    expect(config.sortOrder).toBe('newest');
    expect(config.sourceMode).toBe('all');
    expect(config.typeFilter).toEqual(['rss']);
  });
});

describe('fromRemote', () => {
  it('parses valid config JSON', () => {
    const remote = makeRemote({
      uuid: 'a',
      name: 'News',
      config:
        '{"readFilter":"unread","sortOrder":"oldest","sourceMode":"include","sourceKeys":["rss~abc"]}',
    });
    const result = fromRemote(remote);
    expect(result.uuid).toBe('a');
    expect(result.name).toBe('News');
    expect(result.readFilter).toBe('unread');
    expect(result.sortOrder).toBe('oldest');
    expect(result.sourceMode).toBe('include');
    expect(result.sourceKeys).toEqual(['rss~abc']);
  });

  it('falls back to defaults on invalid JSON', () => {
    const remote = makeRemote({ uuid: 'b', config: 'not-json' });
    const result = fromRemote(remote);
    expect(result.readFilter).toBe('all');
    expect(result.sortOrder).toBe('newest');
  });

  it('falls back to defaults on empty config', () => {
    const remote = makeRemote({ uuid: 'c', config: '{}' });
    const result = fromRemote(remote);
    expect(result.readFilter).toBe('all');
    expect(result.sortOrder).toBe('newest');
  });
});

describe('computeSyncOperations', () => {
  it('adds remote-only channels locally', () => {
    const local: FilteredView[] = [];
    const remote = [makeRemote({ uuid: 'r1', name: 'Remote Channel' })];
    const ops = computeSyncOperations(local, remote, [], new Set());
    expect(ops.addLocally).toHaveLength(1);
    expect(ops.addLocally[0].uuid).toBe('r1');
    expect(ops.addLocally[0].name).toBe('Remote Channel');
    expect(ops.pushToRemote).toHaveLength(0);
  });

  it('pushes local-only channels to remote', () => {
    const local = [makeView({ uuid: 'l1', name: 'Local Channel' })];
    const remote: RemoteChannel[] = [];
    const ops = computeSyncOperations(local, remote, [], new Set());
    expect(ops.pushToRemote).toHaveLength(1);
    expect(ops.pushToRemote[0].uuid).toBe('l1');
    expect(ops.addLocally).toHaveLength(0);
  });

  it('updates local when remote is newer', () => {
    const local = [makeView({ uuid: 'c1', updatedAt: 1000 })];
    const remote = [makeRemote({ uuid: 'c1', updatedAt: 2000, name: 'Updated' })];
    const ops = computeSyncOperations(local, remote, [], new Set());
    expect(ops.updateLocally).toHaveLength(1);
    expect(ops.updateLocally[0].uuid).toBe('c1');
    expect(ops.updateLocally[0].data.name).toBe('Updated');
  });

  it('does not update local when local is newer', () => {
    const local = [makeView({ uuid: 'c1', updatedAt: 3000 })];
    const remote = [makeRemote({ uuid: 'c1', updatedAt: 2000 })];
    const ops = computeSyncOperations(local, remote, [], new Set());
    expect(ops.updateLocally).toHaveLength(0);
    expect(ops.pushToRemote).toHaveLength(0); // both sides have it
  });

  it('does nothing when timestamps match', () => {
    const local = [makeView({ uuid: 'c1', updatedAt: 1000 })];
    const remote = [makeRemote({ uuid: 'c1', updatedAt: 1000 })];
    const ops = computeSyncOperations(local, remote, [], new Set());
    expect(ops.updateLocally).toHaveLength(0);
    expect(ops.addLocally).toHaveLength(0);
    expect(ops.pushToRemote).toHaveLength(0);
    expect(ops.deleteLocally).toHaveLength(0);
  });

  it('deletes local channels that were deleted on remote', () => {
    const local = [makeView({ uuid: 'c1' }), makeView({ uuid: 'c2', id: 2 })];
    const remote: RemoteChannel[] = [];
    const ops = computeSyncOperations(local, remote, ['c1'], new Set());
    expect(ops.deleteLocally).toEqual(['c1']);
    expect(ops.pushToRemote).toHaveLength(1);
    expect(ops.pushToRemote[0].uuid).toBe('c2');
  });

  it('does not re-add remotely-deleted channels', () => {
    const local: FilteredView[] = [];
    const remote = [makeRemote({ uuid: 'c1' })];
    const ops = computeSyncOperations(local, remote, ['c1'], new Set());
    expect(ops.addLocally).toHaveLength(0);
  });

  it('clears pending delete when remote confirms deletion', () => {
    const local = [makeView({ uuid: 'c1' })];
    const pendingDeletes = new Set(['c1']);
    const ops = computeSyncOperations(local, [], ['c1'], pendingDeletes);
    expect(ops.pendingDeletesAfter.has('c1')).toBe(false);
  });

  it('retries pending deletes not yet confirmed by remote', () => {
    const local: FilteredView[] = [];
    const pendingDeletes = new Set(['c1']);
    const ops = computeSyncOperations(local, [], [], pendingDeletes);
    expect(ops.retryDeletes).toContain('c1');
    expect(ops.pendingDeletesAfter.has('c1')).toBe(true);
  });

  it('does not push channels that are pending-deleted locally', () => {
    const local = [makeView({ uuid: 'c1' })];
    const pendingDeletes = new Set(['c1']);
    const ops = computeSyncOperations(local, [], [], pendingDeletes);
    expect(ops.pushToRemote).toHaveLength(0);
  });

  it('does not add remote channels that are pending-deleted locally', () => {
    const local: FilteredView[] = [];
    const remote = [makeRemote({ uuid: 'c1' })];
    const pendingDeletes = new Set(['c1']);
    const ops = computeSyncOperations(local, remote, [], pendingDeletes);
    expect(ops.addLocally).toHaveLength(0);
  });

  it('handles complex multi-channel scenario', () => {
    const local = [
      makeView({ uuid: 'shared', id: 1, updatedAt: 1000 }),
      makeView({ uuid: 'local-only', id: 2 }),
      makeView({ uuid: 'to-delete', id: 3 }),
    ];
    const remote = [
      makeRemote({ uuid: 'shared', updatedAt: 2000, name: 'Shared Updated' }),
      makeRemote({ uuid: 'remote-only', name: 'From Other Device' }),
    ];
    const ops = computeSyncOperations(local, remote, ['to-delete'], new Set());

    expect(ops.updateLocally).toHaveLength(1);
    expect(ops.updateLocally[0].uuid).toBe('shared');
    expect(ops.addLocally).toHaveLength(1);
    expect(ops.addLocally[0].uuid).toBe('remote-only');
    expect(ops.pushToRemote).toHaveLength(1);
    expect(ops.pushToRemote[0].uuid).toBe('local-only');
    expect(ops.deleteLocally).toEqual(['to-delete']);
  });
});
