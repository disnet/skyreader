<script lang="ts">
  import { page } from '$app/stores';
  import { api } from '$lib/services/api';
  import Logo from '$lib/assets/logo.svg';

  let handle = $state('');
  let isLoading = $state(false);
  let error = $state<string | null>(null);

  // Compute the normalized handle for display hint
  const normalizedHandle = $derived.by(() => {
    const trimmed = handle.trim().toLowerCase();
    if (!trimmed) return '';
    const withoutAt = trimmed.startsWith('@') ? trimmed.substring(1) : trimmed;
    return withoutAt.includes('.') ? withoutAt : `${withoutAt}.bsky.social`;
  });

  // Show hint when user enters a handle without a dot
  const showNormalizationHint = $derived.by(() => {
    const trimmed = handle.trim();
    if (!trimmed) return false;
    const withoutAt = trimmed.startsWith('@') ? trimmed.substring(1) : trimmed;
    return !withoutAt.includes('.') && withoutAt.length > 0;
  });

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
    <div class="logo-header">
      <img src={Logo} alt="Skyreader" class="login-logo" />
      <h1>Skyreader</h1>
    </div>
    <p>Sign in with your Bluesky account</p>

    <form onsubmit={handleSubmit}>
      <div class="form-group">
        <label for="handle">Bluesky Handle</label>
        <input
          type="text"
          id="handle"
          class="input"
          placeholder="yourname or yourname.bsky.social"
          bind:value={handle}
          disabled={isLoading}
          autocapitalize="none"
          autocorrect="off"
          spellcheck="false"
        />
        {#if showNormalizationHint}
          <p class="hint">Will sign in as <strong>{normalizedHandle}</strong></p>
        {/if}
      </div>

      {#if error}
        <p class="error">{error}</p>
      {/if}

      <button type="submit" class="btn btn-primary" disabled={isLoading || !handle.trim()}>
        {isLoading ? 'Redirecting...' : 'Continue with Bluesky'}
      </button>
    </form>

    <p class="info">
      You'll be redirected to your Bluesky server to authorize Skyreader.
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

  .logo-header {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.75rem;
    margin-bottom: 0.5rem;
  }

  .login-logo {
    width: 72px;
    height: 72px;
  }

  .login-card h1 {
    font-size: 1.5rem;
    margin: 0;
  }

  .login-card > p {
    color: var(--color-text-secondary);
    margin-bottom: 1.5rem;
    text-align: center;
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

  .hint {
    font-size: 0.8rem;
    color: var(--color-text-secondary);
    margin-top: 0.25rem;
    margin-bottom: 0;
  }

  .hint strong {
    color: var(--color-text-primary);
  }
</style>
