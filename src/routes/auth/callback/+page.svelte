<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { page } from '$app/stores';
	import { auth } from '$lib/stores/auth.svelte';
	import { api } from '$lib/services/api';
	import { subscriptionsStore } from '$lib/stores/subscriptions.svelte';
	import { readingStore } from '$lib/stores/reading.svelte';
	import { sharesStore } from '$lib/stores/shares.svelte';

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

			// Sync subscriptions from backend
			await subscriptionsStore.syncFromBackend();

			// Load read positions and shares from backend
			await readingStore.load();
			await sharesStore.load();

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
