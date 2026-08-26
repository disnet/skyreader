import { describe, expect, it } from 'vitest';
import { transitionSavedSearchSurface, type SavedSearchSurfaceState } from './savedSearchSurface';

const initial: SavedSearchSurfaceState = { owner: null, handoffPending: false };

describe('saved search surface ownership', () => {
  it('ignores a stale release after a newer surface claims search', () => {
    const home = transitionSavedSearchSurface(initial, { type: 'claim', owner: 'home' }).state;
    const saved = transitionSavedSearchSurface(home, { type: 'claim', owner: 'saved' }).state;
    const staleRelease = transitionSavedSearchSurface(saved, { type: 'release', owner: 'home' });

    expect(staleRelease.state.owner).toBe('saved');
    expect(staleRelease.close).toBe(false);
  });

  it('closes search when the current owner releases it', () => {
    const home = transitionSavedSearchSurface(initial, { type: 'claim', owner: 'home' }).state;
    const release = transitionSavedSearchSurface(home, { type: 'release', owner: 'home' });

    expect(release.state.owner).toBeNull();
    expect(release.close).toBe(true);
  });

  it('preserves search for exactly one surface handoff', () => {
    const home = transitionSavedSearchSurface(initial, { type: 'claim', owner: 'home' }).state;
    const handoff = transitionSavedSearchSurface(home, { type: 'begin-handoff' }).state;
    const release = transitionSavedSearchSurface(handoff, { type: 'release', owner: 'home' });
    const claim = transitionSavedSearchSurface(release.state, { type: 'claim', owner: 'saved' });
    const finalRelease = transitionSavedSearchSurface(claim.state, {
      type: 'release',
      owner: 'saved',
    });

    expect(release.close).toBe(false);
    expect(claim.reopen).toBe(true);
    expect(claim.state.handoffPending).toBe(false);
    expect(finalRelease.close).toBe(true);
  });
});
