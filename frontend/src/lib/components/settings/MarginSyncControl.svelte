<script lang="ts">
  // The Margin highlight sync switch, and what the sync is doing: when it last
  // ran, whether it's running, whether it stopped because the grant lapsed.
  // Shared by Settings (and the review deck's gear) and the top of /highlights,
  // so the switch and what it says can't drift between them.
  //
  // The Margin toggle is gated on the margin scopes even though the read itself
  // is public XRPC: without them, editing an imported highlight's note would
  // queue a PDS write the session can't perform. Same posture as
  // SaveBackingPicker — disabled plus a grant prompt, never a broken half-state.
  import { onMount } from 'svelte';
  import { auth } from '$lib/stores/auth.svelte';
  import { api } from '$lib/services/api';
  import { syncStore } from '$lib/stores/sync.svelte';
  import { itemLabelsStore } from '$lib/stores/itemLabels.svelte';
  import { savesStore } from '$lib/stores/saves.svelte';
  import { preferences } from '$lib/stores/preferences.svelte';
  import { marginSyncStore } from '$lib/stores/marginSync.svelte';
  import { formatRelativeTime } from '$lib/utils/date';
  import { maybeImportMarginHighlights } from '$lib/services/marginHighlightImport';
  import SettingToggle from './SettingToggle.svelte';

  interface Props {
    returnUrl?: string;
    /** Fired when switching the toggle on actually brought highlights in, so a
        host showing those highlights (the review deck) can react. */
    onImported?: (imported: number) => void;
    /** `bar`: one quiet line at the top of /highlights, the status beside the switch. */
    variant?: 'settings' | 'bar';
  }

  let { returnUrl = '/settings', onImported, variant = 'settings' }: Props = $props();

  // "Synced 5m ago" has to keep moving while the page sits open.
  let now = $state(Date.now());
  onMount(() => {
    const timer = setInterval(() => (now = Date.now()), 30_000);
    return () => clearInterval(timer);
  });

  let lastSyncedAt = $derived(marginSyncStore.lastSyncedAt(auth.user?.did));
  let status = $derived.by((): string | null => {
    if (!preferences.marginHighlightImport) return null;
    if (marginSyncStore.syncing || importing) return 'Syncing…';
    if (lastSyncedAt === null) return 'Not synced yet.';
    void now;
    const partial = marginSyncStore.truncated ? ' Some highlights couldn’t be fetched yet.' : '';
    return `Synced ${formatRelativeTime(lastSyncedAt)}.${partial}`;
  });

  let loaded = $state(false);
  // Three states, not two. Offline and a failed status call both leave the grant
  // unknown, and treating unknown as missing tells a reader who granted the
  // scopes months ago to grant them again — while offline, where the grant
  // round-trip can't complete. It also locks the toggle, so they
  // can't even switch the import off.
  let marginScopes = $state<'unknown' | 'granted' | 'missing'>('unknown');
  let importing = $state(false);
  let importNote = $state<string | null>(null);

  onMount(async () => {
    if (!syncStore.isOnline) {
      loaded = true;
      return;
    }
    try {
      const status = await api.getIntegrationStatus();
      marginScopes = status.scopeStatus.margin ? 'granted' : 'missing';
    } catch (error) {
      console.error('Failed to load integration status:', error);
    }
    loaded = true;
  });

  function grantMarginAccess() {
    void auth.grantPermissions(['margin'], returnUrl);
  }

  // Keeping the promise the toggle makes when it lands mid-hydration. The deck
  // and the list each have an effect that calls the import once their stores are
  // ready; the panel can be mounted on /settings, where nothing else will.
  let storesReady = $derived(!itemLabelsStore.isLoading && !savesStore.loading);
  let awaitingStores = $state(false);

  $effect(() => {
    if (!awaitingStores || !storesReady) return;
    awaitingStores = false;
    void toggleImport(true);
  });

  async function toggleImport(enabled: boolean) {
    preferences.setMarginHighlightImport(enabled);
    marginSyncStore.clearLapsed();
    importNote = null;
    if (!enabled) {
      // Switching off has to cancel the deferred retry too. Without this, a
      // reader who turned it on mid-hydration and changed their mind before the
      // stores landed would watch the effect below switch it back on for them.
      awaitingStores = false;
      return;
    }
    // Turning it on should do something visible right away, not in 15 minutes.
    importing = true;
    try {
      const outcome = await maybeImportMarginHighlights({ force: true });
      if (outcome.status === 'imported') {
        if (outcome.truncated) {
          importNote = `Brought in ${outcome.imported}. Some highlights couldn’t be fetched yet.`;
        } else if (outcome.imported === 0) {
          const changed = outcome.updated + outcome.removed + outcome.unpublished;
          importNote =
            changed > 0
              ? `Brought over ${changed} change${changed === 1 ? '' : 's'} from Margin.`
              : 'Nothing new to bring in.';
        } else {
          importNote = `Brought in ${outcome.imported} highlight${
            outcome.imported === 1 ? '' : 's'
          }.`;
        }
        if (outcome.imported > 0) onImported?.(outcome.imported);
      } else if (outcome.status === 'scope-expired') {
        // The grant is gone and the import switched itself back off. Say that,
        // rather than blaming the network for a permissions problem — and let
        // the "Allow Margin access" prompt below appear, the way out of it.
        marginScopes = 'missing';
        importNote = null;
      } else if (outcome.status === 'skipped' && outcome.reason === 'stores-loading') {
        // The import is gated on the local highlights being read: it writes each
        // item's whole set, so running early would overwrite what it can't see.
        awaitingStores = true;
        importNote = 'Bringing them in as soon as your highlights finish loading.';
      } else if (outcome.status === 'skipped' && outcome.reason === 'offline') {
        importNote = 'Offline. Skyreader will bring them in once you’re back.';
      } else {
        importNote = 'Couldn’t reach Margin just now. Skyreader will try again later.';
      }
    } finally {
      importing = false;
    }
  }
</script>

{#if loaded}
  <div class="margin-sync" class:bar={variant === 'bar'}>
    {#if variant === 'bar'}
      <SettingToggle
        label="Sync with Margin"
        checked={preferences.marginHighlightImport}
        disabled={marginScopes === 'missing' || importing}
        onchange={toggleImport}
      >
        {importNote ??
          status ??
          (marginSyncStore.lapsed
            ? 'Off.'
            : 'Off. Highlights you make in Margin can show up here too.')}
      </SettingToggle>
    {:else}
      <SettingToggle
        label="Sync highlights with Margin"
        checked={preferences.marginHighlightImport}
        disabled={marginScopes === 'missing' || importing}
        onchange={toggleImport}
      >
        Highlights you make in Margin join your library here, and edits or deletes there carry over.
      </SettingToggle>
    {/if}
    {#if marginScopes === 'missing' || marginSyncStore.lapsed}
      <p class="setting-description">
        {marginSyncStore.lapsed
          ? 'Syncing stopped: Margin access lapsed.'
          : 'This needs permission to read and write your Margin notes.'}
        <button
          class="link-btn"
          onclick={grantMarginAccess}
          disabled={auth.grantingPermissions}
          type="button"
        >
          Allow Margin access
        </button>
      </p>
    {:else if marginScopes === 'unknown'}
      <p class="setting-description">
        Couldn't check your Margin permissions just now. Syncing will start once you're back online.
      </p>
    {/if}
    {#if variant === 'settings'}
      {#if importNote}
        <p class="setting-description">{importNote}</p>
      {:else if status}
        <p class="setting-description">{status}</p>
      {/if}
    {/if}
  </div>
{/if}

<style>
  .margin-sync.bar {
    max-width: 1080px;
    margin: 0 auto;
    padding: 0.75rem 1.5rem 0;
  }

  .setting-description {
    margin: 0.5rem 0 0;
    font-size: var(--text-sm);
    color: var(--color-text-secondary);
    line-height: var(--leading-relaxed, 1.5);
  }

  .link-btn {
    padding: 0;
    background: none;
    border: none;
    color: var(--color-primary);
    font: inherit;
    font-weight: var(--weight-medium);
    cursor: pointer;
    text-decoration: underline;
  }

  @media (max-width: 640px) {
    .margin-sync.bar {
      padding: 0.75rem 1rem 0;
    }
  }
</style>
