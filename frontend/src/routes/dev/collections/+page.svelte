<script lang="ts">
  // Harness for the Semble/Margin collection picker. The picker talks to Dexie
  // (the collection cache) and three API calls, so each scenario below seeds the
  // cache and swaps the API methods on the singleton before opening the modal.
  //
  // The route is dev-only, but the api singleton is not: this is one client-side
  // session, so navigating back into the app with the stubs still installed would
  // hand the real UI a fake collection catalog and a settings object with nothing
  // but `backing` in it. The originals are captured before the first patch and put
  // back on destroy.
  import { onDestroy } from 'svelte';
  import CollectionPicker from '$lib/components/CollectionPicker.svelte';
  import Showcase from '../_harness/Showcase.svelte';
  import Case from '../_harness/Case.svelte';
  import { db } from '$lib/services/db';
  import { api } from '$lib/services/api';
  import { collectionsStore } from '$lib/stores/collections.svelte';

  const DID = 'did:plc:harness';
  const uri = (rkey: string) => `at://${DID}/network.cosmik.collection/${rkey}`;
  const DAY = 24 * 60 * 60 * 1000;

  const CATALOG = [
    { rkey: 'saved', name: 'Saved', description: undefined },
    {
      rkey: 'reading',
      name: 'Reading queue',
      description: 'Long things waiting for a quiet hour',
    },
    { rkey: 'ai', name: 'AI safety', description: 'Papers worth a second pass' },
    { rkey: 'proto', name: 'Protocol design', description: undefined },
    { rkey: 'books', name: 'Books to buy', description: undefined },
    { rkey: 'type', name: 'Typography', description: 'Specimens, essays, and type foundry news' },
    { rkey: 'zettel', name: 'Zettel inbox', description: 'Unfiled, needs a home' },
    { rkey: 'urbanism', name: 'Urbanism', description: undefined },
    { rkey: 'emoji', name: '🌊 Ocean reading', description: undefined },
  ];

  const USED: Record<string, number> = {
    reading: Date.now() - 2 * DAY,
    ai: Date.now() - 5 * DAY,
    proto: Date.now() - 23 * DAY,
  };

  type Scenario =
    'recent' | 'fresh' | 'edit' | 'truncated' | 'loading' | 'empty' | 'error' | 'longnames';

  let open = $state(false);
  let scenario = $state<Scenario>('recent');
  let lastResult = $state<string>('—');

  const never = () => new Promise<never>(() => {});

  /* eslint-disable @typescript-eslint/no-explicit-any */
  const client = api as any;
  const PATCHED = ['listSembleCollections', 'getIntegrationMemberships', 'getSettings'] as const;
  // Captured before any scenario runs, so restore is the real implementation
  // rather than whichever stub happened to be installed last.
  const originals = Object.fromEntries(PATCHED.map((m) => [m, client[m]]));

  onDestroy(() => {
    for (const m of PATCHED) client[m] = originals[m];
  });

  async function seed(entries: typeof CATALOG, withRecency: boolean) {
    await db.integrationCollections.where('integration').equals('semble').delete();
    if (entries.length === 0) return;
    await db.integrationCollections.bulkPut(
      entries.map((c) => ({
        integration: 'semble' as const,
        uri: uri(c.rkey),
        cid: `bafy${c.rkey}`,
        name: c.name,
        description: c.description,
        cachedAt: Date.now(),
        lastUsedAt: withRecency ? USED[c.rkey] : undefined,
      }))
    );
  }

  async function run(next: Scenario) {
    scenario = next;
    open = false;
    lastResult = '—';

    // Reset the API surface, then let each scenario override what it needs.
    let backing: { provider: 'semble'; collectionUri: string } | null = null;
    // The listing answer has to match what was seeded: loadAndRefresh replaces
    // state with the network answer, so a scenario that seeds one list and
    // serves another would show the served one.
    let entries = CATALOG;
    let recency = true;
    client.listSembleCollections = async () => ({
      collections: entries.map((c) => ({ uri: uri(c.rkey), cid: `bafy${c.rkey}`, ...c })),
    });
    client.getIntegrationMemberships = async () => ({
      items: [],
      memberships: [],
      truncated: false,
    });
    // The picker calls saveBackingStore.load() on every open, so the backing a
    // scenario wants has to come back from here rather than be pushed in.
    client.getSettings = async () => ({ backing });

    switch (next) {
      case 'recent':
        backing = { provider: 'semble', collectionUri: uri('saved') };
        break;
      case 'fresh':
        recency = false;
        break;
      case 'longnames':
        entries = CATALOG.map((c) => ({
          ...c,
          name: `${c.name} that somebody named far past the width of this modal`,
          description:
            'A description long enough to need truncating, which is the common case for imported collections.',
        }));
        break;
      case 'edit':
        backing = { provider: 'semble', collectionUri: uri('saved') };
        client.getIntegrationMemberships = async () => ({
          items: [{ uri: `at://${DID}/network.cosmik.card/x`, cid: 'bafycard' }],
          memberships: [
            { collectionUri: uri('saved'), linkUri: `at://${DID}/network.cosmik.link/1` },
            { collectionUri: uri('ai'), linkUri: `at://${DID}/network.cosmik.link/2` },
          ],
          truncated: false,
        });
        break;
      case 'truncated':
        client.getIntegrationMemberships = async () => ({
          items: [],
          memberships: [],
          truncated: true,
        });
        break;
      case 'loading':
        entries = [];
        client.listSembleCollections = never;
        client.getIntegrationMemberships = never;
        break;
      case 'empty':
        entries = [];
        break;
      case 'error':
        entries = [];
        client.listSembleCollections = async () => {
          throw new Error("Semble didn't answer. Try again in a moment.");
        };
        break;
    }
    // invalidate() clears the Dexie cache, so the seed goes in after the reset.
    await collectionsStore.invalidate('semble');
    await seed(entries, recency);
    open = true;
  }

  const SCENARIOS: Array<{ id: Scenario; label: string; note: string }> = [
    { id: 'recent', label: 'Recently used', note: 'bands + locked Saved row' },
    { id: 'fresh', label: 'No history', note: 'alphabetical, no bands' },
    { id: 'edit', label: 'Edit mode', note: 'pre-checked, diff in the footer' },
    { id: 'truncated', label: 'Truncated lookup', note: 'warning notice' },
    { id: 'longnames', label: 'Long names', note: 'truncation + description' },
    { id: 'loading', label: 'Loading', note: 'skeleton rows' },
    { id: 'empty', label: 'No collections', note: 'teaching empty state' },
    { id: 'error', label: 'Load failed', note: 'error notice' },
  ];
</script>

<Showcase
  title="Collection picker"
  description="Save to Semble / Margin. Pick a scenario to seed the collection cache and stub the API, then the modal opens on that state."
>
  <Case name="Scenarios" note="Each button reseeds Dexie and reopens the picker." pad frame>
    <div class="row">
      {#each SCENARIOS as s (s.id)}
        <button class="btn" class:on={scenario === s.id} onclick={() => run(s.id)}>
          {s.label}
          <span class="sub">{s.note}</span>
        </button>
      {/each}
    </div>
    <p class="result">Last result: <code>{lastResult}</code></p>
  </Case>
</Showcase>

<CollectionPicker
  integration="semble"
  {open}
  url="https://example.test/an-article"
  onconfirm={(r) => {
    lastResult = JSON.stringify(r);
    open = false;
  }}
  onclose={() => (open = false)}
/>

<style>
  .row {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
  }

  .btn {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 0.125rem;
    padding: 0.5rem 0.75rem;
    border: 1px solid var(--color-border);
    border-radius: 6px;
    background: var(--color-bg);
    color: var(--color-text);
    font: inherit;
    font-size: var(--text-md);
    font-weight: var(--weight-medium);
    cursor: pointer;
    text-align: left;
  }

  .btn:hover {
    background: var(--color-bg-secondary);
  }

  .btn.on {
    border-color: var(--color-primary);
    color: var(--color-primary);
  }

  .sub {
    font-size: var(--text-xs);
    font-weight: var(--weight-regular);
    color: var(--color-text-secondary);
  }

  .result {
    margin-top: 1rem;
    font-size: var(--text-sm);
    color: var(--color-text-secondary);
  }

  code {
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    word-break: break-all;
  }
</style>
