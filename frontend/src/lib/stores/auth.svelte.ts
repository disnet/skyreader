import { browser } from '$app/environment';
import { api } from '$lib/services/api';
import { clearAllData } from '$lib/services/db';
import type { User } from '$lib/types';

interface AuthState {
  user: User | null;
  sessionId: string | null;
  isLoading: boolean;
  error: string | null;
}

function createAuthStore() {
  let state = $state<AuthState>({
    user: null,
    sessionId: null,
    isLoading: true,
    error: null,
  });

  // Handle 401 - session expired/invalid on the backend
  function handleUnauthorized() {
    console.log('Handling unauthorized - clearing session');
    state.user = null;
    state.sessionId = null;
    api.setSession(null);

    if (browser) {
      localStorage.removeItem('at-rss-auth');
      // Redirect to login
      window.location.href = '/auth/login';
    }
  }

  // Restore session from localStorage on init
  if (browser) {
    const stored = localStorage.getItem('at-rss-auth');
    if (stored) {
      try {
        const parsed = JSON.parse(stored);
        state.user = parsed.user;
        state.sessionId = parsed.sessionId;
        api.setSession(parsed.sessionId);
      } catch {
        localStorage.removeItem('at-rss-auth');
      }
    }
    state.isLoading = false;

    // Set up 401 handler
    api.setOnUnauthorized(handleUnauthorized);
  }

  function setSession(user: User, sessionId: string) {
    state.user = user;
    state.sessionId = sessionId;
    state.error = null;
    api.setSession(sessionId);

    if (browser) {
      localStorage.setItem('at-rss-auth', JSON.stringify({ user, sessionId }));
    }
  }

  async function logout() {
    try {
      await api.logout();
    } catch {
      // Ignore logout errors
    }

    state.user = null;
    state.sessionId = null;
    api.setSession(null);

    if (browser) {
      localStorage.removeItem('at-rss-auth');
      await clearAllData();
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
    get sessionId() {
      return state.sessionId;
    },
    get isLoading() {
      return state.isLoading;
    },
    get isAuthenticated() {
      return !!state.user;
    },
    get error() {
      return state.error;
    },
    setSession,
    logout,
    setError,
    clearError,
  };
}

export const auth = createAuthStore();
