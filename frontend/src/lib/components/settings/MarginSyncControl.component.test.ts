// Mounted component test (jsdom) — see the "component" project in vitest.config.ts.
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { mount, unmount, flushSync, tick } from 'svelte';

const importMock = vi.hoisted(() => vi.fn());
const online = vi.hoisted(() => ({ value: true }));
const statusMock = vi.hoisted(() => vi.fn());

vi.mock('$lib/services/marginHighlightImport', () => ({
  maybeImportMarginHighlights: importMock,
}));
vi.mock('$lib/services/api', () => ({ api: { getIntegrationStatus: statusMock } }));
vi.mock('$lib/stores/sync.svelte', () => ({
  syncStore: {
    get isOnline() {
      return online.value;
    },
  },
}));
vi.mock('$lib/stores/auth.svelte', () => ({
  auth: { user: { did: 'did:plc:a' }, grantingPermissions: false, grantPermissions: vi.fn() },
}));
vi.mock('$lib/stores/itemLabels.svelte', () => ({ itemLabelsStore: { isLoading: false } }));
vi.mock('$lib/stores/saves.svelte', () => ({ savesStore: { loading: false } }));

import MarginSyncControl from './MarginSyncControl.svelte';
import { marginSyncStore } from '$lib/stores/marginSync.svelte';
import { preferences } from '$lib/stores/preferences.svelte';

const mounted: Record<string, any>[] = [];

async function render() {
  const target = document.createElement('div');
  document.body.appendChild(target);
  mounted.push(mount(MarginSyncControl, { target, props: { variant: 'bar' } }));
  flushSync();
  await new Promise((r) => setTimeout(r, 0));
  flushSync();
  return target;
}

describe('MarginSyncControl (bar)', () => {
  beforeEach(() => {
    localStorage.clear();
    marginSyncStore.reset();
    online.value = true;
    statusMock.mockResolvedValue({ scopeStatus: { margin: true } });
  });
  afterEach(() => {
    for (const component of mounted.splice(0)) unmount(component);
    document.body.innerHTML = '';
    preferences.setMarginHighlightImport(false);
    vi.clearAllMocks();
  });

  it('renders the switch before the permission check lands', () => {
    statusMock.mockReturnValue(new Promise(() => {}));
    const target = document.createElement('div');
    document.body.appendChild(target);
    mounted.push(mount(MarginSyncControl, { target, props: { variant: 'bar' } }));
    flushSync();
    const input = target.querySelector('input[type="checkbox"]') as HTMLInputElement;
    expect(input).not.toBeNull();
    expect(input.disabled).toBe(true);
  });

  it('lets a later sync replace what the toggle said', async () => {
    importMock.mockResolvedValue({
      status: 'imported',
      imported: 0,
      updated: 0,
      removed: 0,
      unpublished: 0,
      truncated: false,
    });
    const target = await render();
    const input = target.querySelector('input[type="checkbox"]') as HTMLInputElement;
    input.click();
    await tick();
    await new Promise((r) => setTimeout(r, 0));
    flushSync();
    expect(target.textContent).toContain('Nothing new to bring in.');

    marginSyncStore.started();
    flushSync();
    expect(target.textContent).toContain('Syncing…');
    marginSyncStore.finished('did:plc:a', { truncated: true });
    flushSync();
    expect(target.textContent).toContain('Synced');
    expect(target.textContent).toContain('couldn’t be fetched yet');
  });

  it('says nothing about permissions while offline with the sync off', async () => {
    online.value = false;
    const target = await render();
    expect(target.textContent).not.toContain('permissions');
    expect(target.textContent).not.toContain('Offline');
  });

  it('says a failed sync failed', async () => {
    preferences.setMarginHighlightImport(true);
    const target = await render();
    marginSyncStore.finished('did:plc:a', null, { failed: true });
    flushSync();
    expect(target.textContent).toContain('Couldn’t reach Margin');
  });
});
