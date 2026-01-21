<script lang="ts">
  import Logo from '$lib/assets/logo.svg';
</script>

<div class="login-page">
  <div class="login-card card">
    <div class="logo-header">
      <img src={Logo} alt="Skyreader" class="login-logo" />
      <h1>Skyreader</h1>
    </div>

    <div class="offline-notice">
      <h2>Temporarily Offline</h2>
      <p>We're experiencing higher than expected traffic and are working to scale up our servers.</p>
      <p>Check back soon!</p>
    </div>

    <a href="/" class="btn btn-secondary">Back to Home</a>
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
    margin-bottom: 1.5rem;
  }

  .login-logo {
    width: 72px;
    height: 72px;
  }

  .login-card h1 {
    font-size: 1.5rem;
    margin: 0;
  }

  .offline-notice {
    background: linear-gradient(135deg, #fff3cd 0%, #ffe69c 100%);
    border: 1px solid #ffc107;
    border-radius: 8px;
    padding: 1.5rem;
    margin-bottom: 1.5rem;
  }

  .offline-notice h2 {
    margin: 0 0 0.5rem 0;
    font-size: 1.25rem;
    color: #856404;
  }

  .offline-notice p {
    margin: 0.5rem 0 0 0;
    font-size: 1rem;
    color: #664d03;
  }

  .btn-secondary {
    display: inline-block;
    padding: 0.75rem 1.5rem;
    background: var(--color-bg-secondary, #e9ecef);
    color: var(--color-text, #333);
    border-radius: 4px;
    text-decoration: none;
    border: 1px solid var(--color-border, #dee2e6);
  }

  .btn-secondary:hover {
    background: var(--color-border, #dee2e6);
  }
</style>
