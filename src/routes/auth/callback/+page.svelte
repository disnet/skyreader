<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { page } from '$app/stores';
	import { auth } from '$lib/stores/auth.svelte';
	import { api } from '$lib/services/api';
	import { appManager } from '$lib/stores/app.svelte';

	onMount(async () => {
		const code = $page.url.searchParams.get('code');
		const returnUrl = $page.url.searchParams.get('returnUrl') || '/';

		if (!code) {
			goto('/auth/error?error=Missing+code');
			return;
		}

		// Check if we already have a valid session
		const stored = localStorage.getItem('skyreader-auth');
		if (stored) {
			goto(returnUrl);
			return;
		}

		try {
			// Exchange the code for a session ID (single-use, not exposed in URL)
			const { sessionId } = await api.exchangeCode(code);

			// Set the session ID so the API can make authenticated requests
			api.setSession(sessionId);

			// Fetch the user info from the backend
			const user = await api.getMe();

			// Store the session with the real user data
			auth.setSession(user, sessionId);

			// Initialize the app (loads subscriptions, articles, read state, etc.)
			await appManager.initialize();

			goto(returnUrl);
		} catch (error) {
			console.error('Failed to complete login:', error);
			goto('/auth/error?error=Failed+to+complete+login');
		}
	});
</script>

<div class="callback-page">
	<p>Completing login...</p>
</div>

<style>
	.callback-page {
		display: flex;
		align-items: center;
		justify-content: center;
		min-height: 50vh;
		color: var(--color-text-secondary);
	}
</style>
