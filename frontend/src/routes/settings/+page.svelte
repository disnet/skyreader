<script lang="ts">
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { auth } from '$lib/stores/auth.svelte';
  import { syncStore } from '$lib/stores/sync.svelte';

  onMount(() => {
    if (!auth.isAuthenticated) {
      goto('/auth/login?returnUrl=/settings');
    }
  });

  async function handleLogout() {
    if (confirm('Are you sure you want to log out?')) {
      await auth.logout();
      goto('/');
    }
  }
</script>

<div class="settings-page">
  <h1>Settings</h1>

  {#if auth.user}
    <section class="card">
      <h2>Account</h2>
      <div class="user-info">
        {#if auth.user.avatarUrl}
          <img src={auth.user.avatarUrl} alt="" class="avatar" />
        {/if}
        <div>
          <p class="display-name">{auth.user.displayName || auth.user.handle}</p>
          <p class="handle">@{auth.user.handle}</p>
          <p class="did">{auth.user.did}</p>
        </div>
      </div>
      <button class="btn btn-danger" onclick={handleLogout}>
        Log Out
      </button>
    </section>
  {/if}

  <section class="card">
    <h2>Sync Status</h2>
    <dl class="status-list">
      <dt>Connection</dt>
      <dd>
        <span class="status-badge" class:online={syncStore.isOnline} class:offline={!syncStore.isOnline}>
          {syncStore.isOnline ? 'Online' : 'Offline'}
        </span>
      </dd>
      <dt>Pending Changes</dt>
      <dd>{syncStore.pendingCount}</dd>
      {#if syncStore.lastSyncedAt}
        <dt>Last Sync</dt>
        <dd>{new Date(syncStore.lastSyncedAt).toLocaleTimeString()}</dd>
      {/if}
    </dl>
    <button class="btn btn-secondary" onclick={() => syncStore.triggerSync()} disabled={!syncStore.isOnline}>
      Sync Now
    </button>
  </section>

  <section class="card">
    <h2>About</h2>
    <p>AT-RSS is a decentralized RSS reader built on the AT Protocol.</p>
    <p>Your data is stored in your Personal Data Server (PDS), giving you full ownership and portability.</p>
  </section>
</div>

<style>
  .settings-page {
    max-width: 600px;
    margin: 0 auto;
  }

  .settings-page h1 {
    margin-bottom: 1.5rem;
  }

  section {
    margin-bottom: 1.5rem;
  }

  section h2 {
    font-size: 1.125rem;
    margin-bottom: 1rem;
    padding-bottom: 0.5rem;
    border-bottom: 1px solid var(--color-border);
  }

  .user-info {
    display: flex;
    gap: 1rem;
    margin-bottom: 1rem;
  }

  .avatar {
    width: 64px;
    height: 64px;
    border-radius: 50%;
  }

  .display-name {
    font-weight: 600;
  }

  .handle {
    color: var(--color-text-secondary);
  }

  .did {
    font-size: 0.75rem;
    color: var(--color-text-secondary);
    word-break: break-all;
  }

  .status-list {
    display: grid;
    grid-template-columns: auto 1fr;
    gap: 0.5rem 1rem;
    margin-bottom: 1rem;
  }

  .status-list dt {
    font-weight: 500;
  }

  .status-badge {
    display: inline-block;
    padding: 0.125rem 0.5rem;
    border-radius: 4px;
    font-size: 0.75rem;
  }

  .status-badge.online {
    background: var(--color-success);
    color: white;
  }

  .status-badge.offline {
    background: var(--color-error);
    color: white;
  }
</style>
