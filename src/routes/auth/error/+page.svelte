<script lang="ts">
	import { page } from '$app/stores';

	// Map error codes to safe, predefined messages to prevent XSS
	const errorMessages: Record<string, string> = {
		access_denied: 'Access was denied. Please try again.',
		invalid_request: 'The login request was invalid. Please try again.',
		invalid_client: 'Client authentication failed. Please try again.',
		invalid_grant: 'The authorization code has expired. Please try again.',
		unauthorized_client: 'This application is not authorized. Please contact support.',
		unsupported_grant_type: 'Authentication method not supported.',
		invalid_scope: 'The requested permissions are invalid.',
		server_error: 'The authentication server encountered an error. Please try again later.',
		temporarily_unavailable:
			'The authentication server is temporarily unavailable. Please try again later.',
		session_expired: 'Your session has expired. Please log in again.',
		callback_failed: 'Authentication callback failed. Please try again.',
		user_cap_reached: 'Skyreader is currently at capacity while in beta. Please check back later!',
	};

	const errorCode = $derived($page.url.searchParams.get('error') || 'unknown');
	const error = $derived(
		errorMessages[errorCode] || 'An unexpected error occurred. Please try again.'
	);
</script>

<div class="error-page">
	<div class="error-card card">
		<h1>Login Failed</h1>
		<p class="error-message">{error}</p>
		<a href="/auth/login" class="btn btn-primary">Try Again</a>
	</div>
</div>

<style>
	.error-page {
		max-width: 400px;
		margin: 4rem auto;
	}

	.error-card {
		padding: 2rem;
		text-align: center;
	}

	.error-card h1 {
		font-size: 1.5rem;
		margin-bottom: 1rem;
		color: var(--color-error);
	}

	.error-message {
		color: var(--color-text-secondary);
		margin-bottom: 1.5rem;
	}
</style>
