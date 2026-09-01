<script lang="ts">
  // What's running, right here, right now.
  //
  // Not telemetry — nothing here is sent anywhere. It exists to turn "it's
  // broken" into a report someone can act on: which build the page is, which
  // build the service worker is (they differ exactly when an update is half
  // applied, which is the shape of most PWA weirdness), how much unsynced work is
  // sitting in IndexedDB, and when the queue last drained.
  import { version } from '$app/environment';
  import { onMount } from 'svelte';
  import { syncStore } from '$lib/stores/sync.svelte';

  // null = we asked and got no answer (no controller, or a worker too old to
  // reply); undefined = we haven't asked yet. Both render as words, not blanks.
  let workerVersion = $state<string | null | undefined>(undefined);
  let copied = $state(false);

  const shortVersion = (value: string) => (value.length > 12 ? value.slice(0, 12) : value);

  // Same round-trip the layout uses to decide whether an update banner is real.
  function controllerVersion(): Promise<string | null> {
    if (!('serviceWorker' in navigator)) return Promise.resolve(null);
    const controller = navigator.serviceWorker.controller;
    if (!controller) return Promise.resolve(null);
    return new Promise((resolve) => {
      const channel = new MessageChannel();
      const timeout = setTimeout(() => resolve(null), 3000);
      channel.port1.onmessage = (event) => {
        clearTimeout(timeout);
        resolve(event.data?.version ?? null);
      };
      controller.postMessage({ type: 'GET_VERSION' }, [channel.port2]);
    });
  }

  onMount(() => {
    void controllerVersion().then((value) => (workerVersion = value));
    void syncStore.updatePendingCount();
  });

  const formatTime = (at: number) => new Date(at).toLocaleTimeString();

  // A service worker on a different build than the page is the single most
  // useful thing on this panel, so say it in words rather than making someone
  // compare two hashes.
  const workerState = $derived.by(() => {
    if (workerVersion === undefined) return 'Checking…';
    if (workerVersion === null) return 'Not controlling this page';
    if (workerVersion === version) return `${shortVersion(workerVersion)} (matches app)`;
    return `${shortVersion(workerVersion)} — differs from app, reload to update`;
  });

  const rows = $derived([
    { label: 'App build', value: shortVersion(version) },
    { label: 'Service worker', value: workerState },
    { label: 'Connection', value: syncStore.isOnline ? 'Online' : 'Offline' },
    {
      label: 'Unsynced changes',
      value: syncStore.pendingCount === 0 ? 'None' : String(syncStore.pendingCount),
    },
    {
      // Now moves on a successful PULL as well as a queue drain, so a device
      // with nothing of its own to push still reports when it last caught up
      // with the others — which is the actual question behind "is my reading
      // synced?".
      label: 'Last sync',
      value: syncStore.lastSyncedAt
        ? formatTime(syncStore.lastSyncedAt)
        : 'Not since this page opened',
    },
  ]);

  async function copy() {
    const text = rows.map((row) => `${row.label}: ${row.value}`).join('\n');
    try {
      await navigator.clipboard.writeText(text);
      copied = true;
      setTimeout(() => (copied = false), 2000);
    } catch {
      // Clipboard denied (or an insecure context) — the values are on screen.
    }
  }
</script>

<section class="card">
  <h2>Diagnostics</h2>
  <p>What this device is running. Useful to include when something looks wrong.</p>

  <dl>
    {#each rows as row (row.label)}
      <div class="row">
        <dt>{row.label}</dt>
        <dd>{row.value}</dd>
      </div>
    {/each}
  </dl>

  <button class="btn btn-secondary" onclick={copy}>{copied ? 'Copied' : 'Copy'}</button>
</section>

<style>
  dl {
    margin: 0 0 1rem;
  }

  .row {
    display: flex;
    justify-content: space-between;
    gap: 1rem;
    padding: 0.4rem 0;
    border-bottom: 1px solid var(--color-border);
    font-size: var(--text-sm);
  }

  .row:last-child {
    border-bottom: none;
  }

  dt {
    color: var(--color-text-secondary);
  }

  dd {
    margin: 0;
    text-align: right;
    font-variant-numeric: tabular-nums;
  }
</style>
