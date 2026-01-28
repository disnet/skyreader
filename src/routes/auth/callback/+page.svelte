<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { page } from '$app/stores';
	import { auth } from '$lib/stores/auth.svelte';
	import { api } from '$lib/services/api';
	import { appManager } from '$lib/stores/app.svelte';
	import { registerPeriodicSync } from '$lib/services/backgroundRefresh';

	onMount(async () => {
		const returnUrl = $page.url.searchParams.get('returnUrl') || '/';

		try {
			// Session cookie was set by the OAuth callback redirect
			// Fetch user info to verify session and get user data
			const user = await api.getMe();

			// Store the user data for display caching
			auth.setUser(user);

			// Initialize the app (loads subscriptions, articles, read state, etc.)
			await appManager.initialize();

			// Register for periodic background sync (Chromium only, fails gracefully on other browsers)
			registerPeriodicSync();

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
