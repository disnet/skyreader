<script lang="ts">
	import { api } from '$lib/services/api';
	import Logo from '$lib/assets/logo.svg';

	let handle = $state('');
	let isLoading = $state(false);
	let error = $state('');

	async function handleSubmit(e: SubmitEvent) {
		e.preventDefault();
		error = '';

		const trimmedHandle = handle.trim();
		if (!trimmedHandle) {
			error = 'Please enter your Bluesky handle';
			return;
		}

		isLoading = true;
		try {
			const { authUrl } = await api.login(trimmedHandle);
			window.location.href = authUrl;
		} catch (err) {
			error = err instanceof Error ? err.message : 'Failed to start login';
			isLoading = false;
		}
	}
</script>

<div class="login-page">
	<div class="login-card card">
		<div class="logo-header">
			<img src={Logo} alt="Skyreader" class="login-logo" />
			<h1>Skyreader</h1>
		</div>

		<p class="tagline">Sign in with your Bluesky account</p>

		<form onsubmit={handleSubmit}>
			<div class="form-group">
				<label for="handle">Bluesky Handle</label>
				<input
					type="text"
					id="handle"
					bind:value={handle}
					placeholder="you.bsky.social"
					disabled={isLoading}
					autocomplete="username"
					autocapitalize="none"
					spellcheck="false"
				/>
			</div>

			{#if error}
				<div class="error">{error}</div>
			{/if}

			<button type="submit" class="btn btn-primary" disabled={isLoading}>
				{isLoading ? 'Connecting...' : 'Continue'}
			</button>
		</form>

		<a href="/" class="back-link">Back to Home</a>
	</div>
</div>

<style>
	.login-page {
		max-width: 400px;
		margin: 4rem auto;
	}

	.login-card {
		padding: 2rem;
		text-align: center;
	}

	.logo-header {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 0.75rem;
		margin-bottom: 1rem;
	}

	.login-logo {
		width: 72px;
		height: 72px;
	}

	.login-card h1 {
		font-size: 1.5rem;
		margin: 0;
	}

	.tagline {
		color: var(--color-text-secondary, #666);
		margin-bottom: 1.5rem;
	}

	.form-group {
		text-align: left;
		margin-bottom: 1rem;
	}

	.form-group label {
		display: block;
		margin-bottom: 0.5rem;
		font-weight: 500;
	}

	.form-group input {
		width: 100%;
		padding: 0.75rem;
		border: 1px solid var(--color-border, #dee2e6);
		border-radius: 4px;
		font-size: 1rem;
		box-sizing: border-box;
	}

	.form-group input:focus {
		outline: none;
		border-color: var(--color-primary, #0066cc);
		box-shadow: 0 0 0 2px rgba(0, 102, 204, 0.2);
	}

	.error {
		background: #f8d7da;
		color: #721c24;
		padding: 0.75rem;
		border-radius: 4px;
		margin-bottom: 1rem;
		font-size: 0.875rem;
	}

	.btn-primary {
		width: 100%;
		padding: 0.75rem 1.5rem;
		background: var(--color-primary, #0066cc);
		color: white;
		border: none;
		border-radius: 4px;
		font-size: 1rem;
		cursor: pointer;
	}

	.btn-primary:hover:not(:disabled) {
		background: var(--color-primary-dark, #0052a3);
	}

	.btn-primary:disabled {
		opacity: 0.65;
		cursor: not-allowed;
	}

	.back-link {
		display: inline-block;
		margin-top: 1.5rem;
		color: var(--color-text-secondary, #666);
		text-decoration: none;
		font-size: 0.875rem;
	}

	.back-link:hover {
		text-decoration: underline;
	}
</style>
