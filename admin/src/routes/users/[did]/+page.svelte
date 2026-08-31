<script lang="ts">
  import DataTable from '$lib/components/DataTable.svelte';

  let { data } = $props();
  let tierLoading = $state(false);
  let tierError = $state('');
  let tierSuccess = $state('');
  let currentTier = $state(data.user.tier ?? 'free');
  // Where the tier came from, and whether the user holds a free-forever grant.
  // Both move together when this page sets a tier, so they're local state too.
  let currentSource = $state(data.user.tier_source ?? null);
  let currentGrant = $state(data.user.granted_tier ?? null);

  // 'admin' and a null source are both hand-granted; only Polar sources are paid.
  const tierOrigin = $derived.by(() => {
    if (currentTier === 'free') return 'free';
    if (currentSource === 'polar_subscription') return 'paid (Polar subscription)';
    if (currentSource === 'polar_order') return 'paid (Polar one-time)';
    return currentSource === 'admin' ? 'granted (admin)' : 'granted (legacy)';
  });

  function formatDate(ts: number | null): string {
    if (!ts) return '—';
    return new Date(ts * 1000).toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });
  }

  async function setTier(event: Event) {
    const select = event.target as HTMLSelectElement;
    const newTier = select.value;
    tierLoading = true;
    tierError = '';
    tierSuccess = '';
    try {
      const res = await fetch(`/users/${encodeURIComponent(data.user.did)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'set_tier', tier: newTier }),
      });
      if (!res.ok) {
        const body = (await res.json()) as { error?: string };
        tierError = body.error || 'Failed to update tier';
        select.value = currentTier;
      } else {
        currentTier = newTier;
        currentSource = 'admin';
        currentGrant = newTier === 'free' ? null : newTier;
        tierSuccess = `Tier updated to ${newTier}`;
        setTimeout(() => {
          tierSuccess = '';
        }, 3000);
      }
    } catch {
      tierError = 'Network error';
      select.value = currentTier;
    } finally {
      tierLoading = false;
    }
  }
</script>

<svelte:head>
  <title>{data.user.handle} — Skyreader Admin</title>
</svelte:head>

<div class="breadcrumb">
  <a href="/users">Users</a> / {data.user.handle}
</div>

<div class="user-header card">
  <div class="user-info">
    {#if data.user.avatar_url}
      <img src={data.user.avatar_url} alt="" class="avatar" />
    {/if}
    <div>
      <h1>{data.user.display_name ?? data.user.handle}</h1>
      <p class="handle">@{data.user.handle}</p>
      <p class="did">{data.user.did}</p>
    </div>
  </div>
  <div class="user-meta">
    <dl>
      <dt>Registered</dt>
      <dd>{formatDate(data.user.registered_at)}</dd>
      <dt>Last Active</dt>
      <dd>{formatDate(data.user.last_active_at)}</dd>
      <dt>PDS</dt>
      <dd>{data.user.pds_url}</dd>
      <dt>Tier</dt>
      <dd>{currentTier}</dd>
      <dt>Tier source</dt>
      <dd>{tierOrigin}</dd>
      <dt>Kept free</dt>
      <dd>{currentGrant ?? '—'}</dd>
    </dl>
  </div>
  <div class="actions">
    <label class="tier-label">
      Tier:
      <select onchange={setTier} disabled={tierLoading} value={currentTier}>
        <option value="free">free</option>
        <option value="supporter">supporter</option>
      </select>
    </label>
    {#if tierError}
      <p class="error-msg">{tierError}</p>
    {/if}
    {#if tierSuccess}
      <p class="success-msg">{tierSuccess}</p>
    {/if}
  </div>
</div>

<h2>Subscriptions ({data.subscriptions.length})</h2>

{#if data.subscriptions.length > 0}
  <DataTable>
    {#snippet header()}
      <th>Feed URL</th>
      <th>Title</th>
      <th>Source</th>
      <th>Added</th>
    {/snippet}

    {#each data.subscriptions as sub}
      <tr>
        <td class="url-cell">{sub.feed_url}</td>
        <td>{sub.title ?? '—'}</td>
        <td>{sub.source ?? 'manual'}</td>
        <td>{formatDate(sub.created_at)}</td>
      </tr>
    {/each}
  </DataTable>
{:else}
  <p class="empty">No subscriptions</p>
{/if}

<style>
  .breadcrumb {
    font-size: 0.875rem;
    margin-bottom: 1rem;
    color: var(--color-text-secondary);
  }

  .breadcrumb a {
    text-decoration: none;
  }

  .user-header {
    margin-bottom: 2rem;
  }

  .user-info {
    display: flex;
    align-items: center;
    gap: 1rem;
    margin-bottom: 1rem;
  }

  .avatar {
    width: 64px;
    height: 64px;
    border-radius: 50%;
  }

  h1 {
    font-size: 1.5rem;
    margin-bottom: 0;
  }

  .handle {
    color: var(--color-primary);
  }

  .did {
    font-size: 0.75rem;
    color: var(--color-text-secondary);
    font-family: var(--font-mono);
  }

  .user-meta dl {
    display: grid;
    grid-template-columns: auto 1fr;
    gap: 0.25rem 1rem;
    font-size: 0.9rem;
  }

  .user-meta dt {
    color: var(--color-text-secondary);
    font-weight: 500;
  }

  .actions {
    margin-top: 1rem;
  }

  .tier-label {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    font-size: 0.9rem;
  }

  .tier-label select {
    padding: 0.25rem 0.5rem;
    border-radius: 4px;
    border: 1px solid var(--color-border);
    background: var(--color-surface);
    color: var(--color-text);
  }

  .error-msg {
    color: var(--color-warning);
    font-size: 0.8rem;
    margin-top: 0.5rem;
  }

  .success-msg {
    color: var(--color-success, #22c55e);
    font-size: 0.8rem;
    margin-top: 0.5rem;
  }

  h2 {
    margin: 1.5rem 0 0.75rem;
  }

  .empty {
    color: var(--color-text-secondary);
    padding: 1rem;
  }

  .url-cell {
    max-width: 300px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
</style>
