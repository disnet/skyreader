<script lang="ts">
  import { goto } from '$app/navigation';
  import { page } from '$app/stores';
  import { api } from '$lib/services/api';

  let handle = $state('');
  let isLoading = $state(false);
  let error = $state<string | null>(null);

  async function handleSubmit(e: Event) {
    e.preventDefault();
    if (!handle.trim()) return;

    isLoading = true;
    error = null;

    try {
      const returnUrl = $page.url.searchParams.get('returnUrl') || '/';
      const result = await api.login(handle.trim(), returnUrl);
      window.location.href = result.authUrl;
    } catch (e) {
      error = e instanceof Error ? e.message : 'Login failed';
      isLoading = false;
    }
  }
</script>

<div class="login-page">
  <div class="login-card card">
    <h1>Login to AT-RSS</h1>
    <p>Sign in with your Bluesky account</p>

    <form onsubmit={handleSubmit}>
      <div class="form-group">
        <label for="handle">Bluesky Handle</label>
        <input
          type="text"
          id="handle"
          class="input"
          placeholder="yourname.bsky.social"
          bind:value={handle}
          disabled={isLoading}
        />
      </div>

      {#if error}
        <p class="error">{error}</p>
      {/if}

      <button type="submit" class="btn btn-primary" disabled={isLoading || !handle.trim()}>
        {isLoading ? 'Redirecting...' : 'Continue with Bluesky'}
      </button>
    </form>

    <p class="info">
      You'll be redirected to your Bluesky server to authorize AT-RSS.
    </p>
  </div>
</div>

<style>
  .login-page {
    max-width: 400px;
    margin: 4rem auto;
  }

  .login-card {
    padding: 2rem;
  }

  .login-card h1 {
    font-size: 1.5rem;
    margin-bottom: 0.5rem;
  }

  .login-card > p {
    color: var(--color-text-secondary);
    margin-bottom: 1.5rem;
  }

  .form-group {
    margin-bottom: 1rem;
  }

  .form-group label {
    display: block;
    margin-bottom: 0.25rem;
    font-weight: 500;
  }

  form button {
    width: 100%;
    margin-top: 0.5rem;
  }

  .info {
    font-size: 0.875rem;
    color: var(--color-text-secondary);
    margin-top: 1rem;
    text-align: center;
  }
</style>
