<script lang="ts">
  import { auth } from '$lib/stores/auth.svelte';
  import { realtimeStore } from '$lib/stores/realtime.svelte';
  import { sidebarStore } from '$lib/stores/sidebar.svelte';
  import Sidebar from '$lib/components/Sidebar.svelte';
  import '../app.css';

  let { children } = $props();

  // Connect/disconnect realtime based on auth state
  $effect(() => {
    if (auth.isAuthenticated && auth.sessionId) {
      realtimeStore.connect(auth.sessionId);
    } else {
      realtimeStore.disconnect();
    }
  });
</script>

<svelte:head>
  <title>AT-RSS</title>
  <meta name="description" content="A decentralized RSS reader built on AT Protocol" />
  <link rel="manifest" href="/manifest.json" />
  <meta name="theme-color" content="#0066cc" />
</svelte:head>

<div class="app">
  {#if !auth.isLoading}
    {#if auth.isAuthenticated}
      <Sidebar />
      <button class="mobile-menu-btn" onclick={() => sidebarStore.toggleMobile()} aria-label="Open menu">
        &#x2630;
      </button>
      <div class="main-wrapper" class:sidebar-collapsed={sidebarStore.isCollapsed}>
        <main>
          {@render children()}
        </main>
      </div>
    {:else}
      <header class="header-full">
        <div class="header-content">
          <a href="/" class="logo">AT-RSS</a>
          <a href="/auth/login" class="login-btn">Login</a>
        </div>
      </header>

      <main class="main-full">
        {@render children()}
      </main>
    {/if}
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

  /* Main wrapper with sidebar margin */
  .main-wrapper {
    margin-left: var(--sidebar-width, 260px);
    min-height: 100vh;
    display: flex;
    flex-direction: column;
    transition: margin-left 0.2s ease;
  }

  .main-wrapper.sidebar-collapsed {
    margin-left: var(--sidebar-collapsed-width, 60px);
  }

  .header-full {
    background: var(--color-bg-secondary, #f5f5f5);
    border-bottom: 1px solid var(--color-border, #e0e0e0);
    padding: 0.75rem 1rem;
    position: sticky;
    top: 0;
    z-index: 100;
  }

  .header-content {
    max-width: 1200px;
    margin: 0 auto;
    display: flex;
    align-items: center;
    gap: 1rem;
  }

  .mobile-menu-btn {
    display: none;
    position: fixed;
    top: 1rem;
    left: 1rem;
    z-index: 45;
    background: var(--color-bg);
    border: 1px solid var(--color-border);
    border-radius: 6px;
    font-size: 1.25rem;
    cursor: pointer;
    padding: 0.5rem 0.75rem;
    color: var(--color-text);
    box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);
  }

  .logo {
    font-weight: 700;
    font-size: 1.25rem;
    color: var(--color-primary, #0066cc);
    text-decoration: none;
  }

  .login-btn {
    background: var(--color-primary, #0066cc);
    color: white;
    padding: 0.5rem 1rem;
    border-radius: 6px;
    text-decoration: none;
    margin-left: auto;
  }

  main {
    flex: 1;
    max-width: 900px;
    width: 100%;
    margin: 0 auto;
    padding: 1rem;
  }

  .main-full {
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
    .main-wrapper {
      margin-left: 0;
    }

    .main-wrapper.sidebar-collapsed {
      margin-left: 0;
    }

    /* Hide floating hamburger - mobile header in page handles this now */
    .mobile-menu-btn {
      display: none;
    }
  }
</style>
