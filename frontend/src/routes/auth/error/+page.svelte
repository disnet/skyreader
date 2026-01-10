<script lang="ts">
  import { page } from '$app/stores';

  const error = $derived($page.url.searchParams.get('error') || 'An unknown error occurred');
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
