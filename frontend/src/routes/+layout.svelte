<script lang="ts">
  import { auth } from '$lib/stores/auth.svelte';
  import { syncStore } from '$lib/stores/sync.svelte';
  import '../app.css';

  let { children } = $props();
</script>

<svelte:head>
  <title>AT-RSS</title>
  <meta name="description" content="A decentralized RSS reader built on AT Protocol" />
  <link rel="manifest" href="/manifest.json" />
  <meta name="theme-color" content="#0066cc" />
</svelte:head>

<div class="app">
  {#if !auth.isLoading}
    <header>
      <nav>
        <a href="/" class="logo">AT-RSS</a>
        <div class="nav-links">
          {#if auth.isAuthenticated}
            <a href="/">Feed</a>
            <a href="/feeds">Subscriptions</a>
            <a href="/social">Social</a>
            <a href="/starred">Starred</a>
          {/if}
        </div>
        <div class="nav-right">
          {#if !syncStore.isOnline}
            <span class="offline-badge">Offline</span>
          {:else if syncStore.pendingCount > 0}
            <span class="sync-badge">{syncStore.pendingCount} pending</span>
          {/if}
          {#if auth.isAuthenticated}
            <a href="/settings" class="user-menu">
              {#if auth.user?.avatarUrl}
                <img src={auth.user.avatarUrl} alt="" class="avatar" />
              {/if}
              <span>@{auth.user?.handle}</span>
            </a>
          {:else}
            <a href="/auth/login" class="login-btn">Login</a>
          {/if}
        </div>
      </nav>
    </header>

    <main>
      {@render children()}
    </main>
  {:else}
    <div class="loading">Loading...</div>
  {/if}
</div>

<style>
  .app {
    min-height: 100vh;
    display: flex;
    flex-direction: column;
  }

  header {
    background: var(--color-bg-secondary, #f5f5f5);
    border-bottom: 1px solid var(--color-border, #e0e0e0);
    padding: 0.75rem 1rem;
    position: sticky;
    top: 0;
    z-index: 100;
  }

  nav {
    max-width: 1200px;
    margin: 0 auto;
    display: flex;
    align-items: center;
    gap: 2rem;
  }

  .logo {
    font-weight: 700;
    font-size: 1.25rem;
    color: var(--color-primary, #0066cc);
    text-decoration: none;
  }

  .nav-links {
    display: flex;
    gap: 1.5rem;
  }

  .nav-links a {
    color: var(--color-text, #333);
    text-decoration: none;
  }

  .nav-links a:hover {
    color: var(--color-primary, #0066cc);
  }

  .nav-right {
    margin-left: auto;
    display: flex;
    align-items: center;
    gap: 1rem;
  }

  .offline-badge {
    background: #f44336;
    color: white;
    padding: 0.25rem 0.5rem;
    border-radius: 4px;
    font-size: 0.75rem;
  }

  .sync-badge {
    background: #ff9800;
    color: white;
    padding: 0.25rem 0.5rem;
    border-radius: 4px;
    font-size: 0.75rem;
  }

  .user-menu {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    text-decoration: none;
    color: var(--color-text, #333);
  }

  .avatar {
    width: 28px;
    height: 28px;
    border-radius: 50%;
  }

  .login-btn {
    background: var(--color-primary, #0066cc);
    color: white;
    padding: 0.5rem 1rem;
    border-radius: 6px;
    text-decoration: none;
  }

  main {
    flex: 1;
    max-width: 1200px;
    width: 100%;
    margin: 0 auto;
    padding: 1rem;
  }

  .loading {
    display: flex;
    align-items: center;
    justify-content: center;
    height: 100vh;
    font-size: 1.25rem;
    color: var(--color-text-secondary, #666);
  }

  @media (max-width: 768px) {
    nav {
      flex-wrap: wrap;
    }

    .nav-links {
      order: 3;
      width: 100%;
      padding-top: 0.5rem;
    }
  }
</style>
