export type SavedSearchSurfaceOwner = 'saved' | 'home';

export interface SavedSearchSurfaceState {
  owner: SavedSearchSurfaceOwner | null;
  handoffPending: boolean;
}

export type SavedSearchSurfaceEvent =
  | { type: 'claim'; owner: SavedSearchSurfaceOwner }
  | { type: 'release'; owner: SavedSearchSurfaceOwner }
  | { type: 'begin-handoff' };

export function transitionSavedSearchSurface(
  state: SavedSearchSurfaceState,
  event: SavedSearchSurfaceEvent
): { state: SavedSearchSurfaceState; close: boolean; reopen: boolean } {
  if (event.type === 'begin-handoff') {
    return { state: { ...state, handoffPending: true }, close: false, reopen: false };
  }

  if (event.type === 'claim') {
    return {
      state: { owner: event.owner, handoffPending: false },
      close: false,
      reopen: state.handoffPending,
    };
  }

  if (state.owner !== event.owner) {
    return { state, close: false, reopen: false };
  }

  return {
    state: { ...state, owner: null },
    close: !state.handoffPending,
    reopen: false,
  };
}
