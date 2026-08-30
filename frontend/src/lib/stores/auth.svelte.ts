import { browser } from '$app/environment';
import { api, OfflineError, SessionRefreshError } from '$lib/services/api';
import type { User } from '$lib/types';

interface AuthState {
  user: User | null;
  isLoading: boolean;
  error: string | null;
  scopeUpgradeRequired: boolean;
}

// A trimmed profile for the login screen's "continue as" affordance. Persisted
// separately from 'skyreader-auth' so it SURVIVES logout — that's the whole
// point: a returning reader clicks their face instead of retyping a handle.
export interface LastUser {
  handle: string;
  displayName?: string;
  avatarUrl?: string;
}

// We keep a most-recent-first list of the accounts that have signed in on this
// device so the login screen can offer any of them, not just the latest.
const RECENT_USERS_KEY = 'skyreader-recent-users';
const MAX_RECENT_USERS = 5;
// Guest reading mode: no account, subscriptions live only in this browser.
const GUEST_KEY = 'skyreader-guest';
// The rkeys of the curated starter feeds seeded by "Start Reading". Kept apart
// from the feeds the guest actually chose so signing in to an EXISTING library
// doesn't silently bulk-add nine sample feeds to it (see app.svelte.ts).
const GUEST_STARTER_KEY = 'skyreader-guest-starter';

function parseRecentUsers(raw: string | null): LastUser[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((u) => u && typeof u.handle === 'string' && u.handle)
      .map((u) => ({
        handle: u.handle as string,
        displayName: typeof u.displayName === 'string' ? u.displayName : undefined,
        avatarUrl: typeof u.avatarUrl === 'string' ? u.avatarUrl : undefined,
      }));
  } catch {
    return [];
  }
}

function rememberLastUser(user: User) {
  if (!browser) return;
  const entry: LastUser = {
    handle: user.handle,
    displayName: user.displayName,
    avatarUrl: user.avatarUrl,
  };
  const existing = parseRecentUsers(localStorage.getItem(RECENT_USERS_KEY));
  // Move this account to the front, drop any prior entry for the same handle,
  // and cap the list. Dedup by handle so a re-login just refreshes the profile.
  const next = [entry, ...existing.filter((u) => u.handle !== entry.handle)].slice(
    0,
    MAX_RECENT_USERS
  );
  localStorage.setItem(RECENT_USERS_KEY, JSON.stringify(next));
}

export function getRecentUsers(): LastUser[] {
  if (!browser) return [];
  return parseRecentUsers(localStorage.getItem(RECENT_USERS_KEY));
}

// Drop a single account from the remembered list (the login screen's "remove"
// affordance). Returns the remaining list for convenience.
export function forgetRecentUser(handle: string): LastUser[] {
  if (!browser) return [];
  const next = parseRecentUsers(localStorage.getItem(RECENT_USERS_KEY)).filter(
    (u) => u.handle !== handle
  );
  localStorage.setItem(RECENT_USERS_KEY, JSON.stringify(next));
  return next;
}

function createAuthStore() {
  let state = $state<AuthState>({
    user: null,
    isLoading: true,
    error: null,
    scopeUpgradeRequired: false,
  });

  // Guest mode is a SIGNAL, not a localStorage read: every consumer gates
  // rendering on it (the AppShell import, the route guard, the sidebar), and a
  // plain `localStorage.getItem` in a getter tracks nothing — clicking "Start
  // Reading" would set the key and re-run no effect, leaving the reader rendered
  // bare inside the marketing chrome until a manual reload. localStorage stays
  // the durable copy; this is the reactive one.
  let isGuestMode = $state(browser && localStorage.getItem(GUEST_KEY) === '1');

  // Handle 401 - session expired/invalid on the backend
  function handleUnauthorized() {
    // A guest has no session to expire. Bouncing them to /auth/login because a
    // stray authenticated call leaked would eject them mid-read.
    if (isGuestMode && !state.user) {
      console.log('Ignoring unauthorized in guest mode');
      return;
    }
    console.log('Handling unauthorized - clearing session');
    state.user = null;

    if (browser) {
      localStorage.removeItem('skyreader-auth');
      // Redirect to login
      window.location.href = '/auth/login';
    }
  }

  // Restore session from localStorage on init
  // User data is cached for display, but session is verified via cookie
  if (browser) {
    const stored = localStorage.getItem('skyreader-auth');
    if (stored) {
      try {
        const parsed = JSON.parse(stored);
        // Support both old format { user, sessionId } and new format { user }
        state.user = parsed.user;
      } catch {
        localStorage.removeItem('skyreader-auth');
      }
    }
    state.isLoading = false;

    // Set up 401 handler
    api.setOnUnauthorized(handleUnauthorized);

    // Set up scope upgrade handler
    api.setOnScopeUpgradeRequired(() => {
      state.scopeUpgradeRequired = true;
    });
  }

  // Set user after successful authentication
  // Session is managed via HTTP-only cookies
  function setUser(user: User) {
    state.user = user;
    state.error = null;

    if (browser) {
      // Store only user info for display caching (session is in HTTP-only cookie)
      localStorage.setItem('skyreader-auth', JSON.stringify({ user }));
      rememberLastUser(user);
    }
  }

  function enterGuestMode() {
    if (!browser) return;
    localStorage.setItem(GUEST_KEY, '1');
    isGuestMode = true;
  }

  function exitGuestMode() {
    if (!browser) return;
    localStorage.removeItem(GUEST_KEY);
    localStorage.removeItem(GUEST_STARTER_KEY);
    isGuestMode = false;
  }

  // Record which local subscriptions came from the curated starter channels
  // rather than from the reader's own choices.
  function rememberStarterRkeys(rkeys: string[]) {
    if (!browser) return;
    localStorage.setItem(GUEST_STARTER_KEY, JSON.stringify(rkeys));
  }

  function starterRkeys(): string[] {
    if (!browser) return [];
    try {
      const parsed = JSON.parse(localStorage.getItem(GUEST_STARTER_KEY) || '[]');
      return Array.isArray(parsed) ? parsed.filter((r): r is string => typeof r === 'string') : [];
    } catch {
      return [];
    }
  }

  // Prime the display cache WITHOUT flipping auth state. Used by the OAuth
  // callback when bouncing straight back to a public page (e.g. a linkblog):
  // keeping the 'skyreader-auth' marker lets a later app visit restore the
  // session, but we must NOT set state.user here — that would mount the
  // authenticated app chrome (sidebar + appManager.initialize) for a frame
  // before the redirect, flashing the full app on the way out.
  function cacheUser(user: User) {
    if (browser) {
      localStorage.setItem('skyreader-auth', JSON.stringify({ user }));
      rememberLastUser(user);
    }
  }

  async function logout() {
    try {
      await api.logout();
    } catch {
      // Ignore logout errors
    }

    state.user = null;

    if (browser) {
      localStorage.removeItem('skyreader-auth');
      // Dynamically imported so the IndexedDB layer (Dexie) and background-sync
      // service stay out of the always-loaded auth chunk — they're only needed
      // here, at logout. Keeping them lazy is what lets the logged-out landing
      // page avoid downloading the app's data layer.
      const [{ clearAllData }, { unregisterPeriodicSync }] = await Promise.all([
        import('$lib/services/db'),
        import('$lib/services/backgroundRefresh'),
      ]);
      await clearAllData();
      // Unregister from periodic background sync
      await unregisterPeriodicSync();
    }
  }

  // Verify session is still valid by calling the backend
  async function verifySession(): Promise<boolean> {
    try {
      const user = await api.getMe();
      setUser(user);
      return true;
    } catch (error) {
      if (error instanceof OfflineError || error instanceof SessionRefreshError) {
        return !!state.user;
      }

      // Session invalid - clear local state
      state.user = null;
      if (browser) {
        localStorage.removeItem('skyreader-auth');
      }
      return false;
    }
  }

  function setError(error: string) {
    state.error = error;
  }

  function clearError() {
    state.error = null;
  }

  return {
    get user() {
      return state.user;
    },
    get isLoading() {
      return state.isLoading;
    },
    get isAuthenticated() {
      return !!state.user;
    },
    get isGuest() {
      return isGuestMode && !state.user;
    },
    // Guest data is waiting to be migrated: the marker is still set even though
    // an account is now signed in.
    get hasGuestData() {
      return isGuestMode;
    },
    // "Is the reader inside the app at all" — true for an account and a guest.
    // The reading surfaces gate on this; account actions keep gating on
    // isAuthenticated.
    get isInApp() {
      return !!state.user || isGuestMode;
    },
    get error() {
      return state.error;
    },
    get scopeUpgradeRequired() {
      return state.scopeUpgradeRequired;
    },
    dismissScopeUpgrade() {
      state.scopeUpgradeRequired = false;
    },
    setUser,
    cacheUser,
    enterGuestMode,
    exitGuestMode,
    rememberStarterRkeys,
    starterRkeys,
    verifySession,
    logout,
    setError,
    clearError,
  };
}

export const auth = createAuthStore();
