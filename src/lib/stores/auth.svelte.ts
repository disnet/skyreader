import { browser } from '$app/environment';
import { api } from '$lib/services/api';
import { clearAllData } from '$lib/services/db';
import { unregisterPeriodicSync } from '$lib/services/backgroundRefresh';
import type { User } from '$lib/types';

interface AuthState {
	user: User | null;
	isLoading: boolean;
	error: string | null;
}

function createAuthStore() {
	let state = $state<AuthState>({
		user: null,
		isLoading: true,
		error: null,
	});

	// Handle 401 - session expired/invalid on the backend
	function handleUnauthorized() {
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
	}

	// Set user after successful authentication
	// Session is managed via HTTP-only cookies
	function setUser(user: User) {
		state.user = user;
		state.error = null;

		if (browser) {
			// Store only user info for display caching (session is in HTTP-only cookie)
			localStorage.setItem('skyreader-auth', JSON.stringify({ user }));
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
		} catch {
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
		get error() {
			return state.error;
		},
		setUser,
		verifySession,
		logout,
		setError,
		clearError,
	};
}

export const auth = createAuthStore();
