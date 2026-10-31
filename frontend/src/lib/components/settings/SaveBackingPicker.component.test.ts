// Mounted component test (jsdom) — see the "component" project in vitest.config.ts.
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';

const api = vi.hoisted(() => ({
  getSettings: vi.fn(),
  getIntegrationStatus: vi.fn(),
  backingCopy: vi.fn(),
}));
vi.mock('$lib/services/api', () => ({ api, ScopeUpgradeError: class extends Error {} }));
vi.mock('$lib/stores/sync.svelte', () => ({ syncStore: { isOnline: true } }));
vi.mock('$lib/stores/auth.svelte', () => ({ auth: { user: { did: 'did:plc:a' } } }));
vi.mock('$lib/stores/saves.svelte', () => ({ savesStore: { load: vi.fn() } }));
vi.mock('$lib/stores/collections.svelte', () => ({
  collectionsStore: { collections: { semble: [], margin: [] } },
}));
vi.mock('$lib/stores/saveBacking.svelte', () => ({
  saveBackingStore: { set: vi.fn(), load: vi.fn() },
}));

import SaveBackingPicker from './SaveBackingPicker.svelte';

const COLLECTION = 'at://did:plc:a/at.margin.collection/c';
const mounted: Record<string, any>[] = [];

async function settle() {
  for (let i = 0; i < 4; i++) {
    await new Promise((r) => setTimeout(r, 0));
    flushSync();
  }
}

async function render() {
  const target = document.createElement('div');
  document.body.appendChild(target);
  mounted.push(mount(SaveBackingPicker, { target, props: {} }));
  await settle();
  return target;
}

function text(target: HTMLElement) {
  return (target.textContent ?? '').replace(/\s+/g, ' ');
}

function button(target: HTMLElement, name: string) {
  return [...target.querySelectorAll('button')].find((b) => b.textContent?.trim() === name);
}

describe('SaveBackingPicker: the background copy', () => {
  beforeEach(() => {
    api.getSettings.mockResolvedValue({
      backing: { provider: 'margin', collectionUri: COLLECTION },
      lastSuccessfulBackingPoll: null,
    });
    api.getIntegrationStatus.mockResolvedValue({ scopeStatus: { semble: true, margin: true } });
  });
  afterEach(() => {
    for (const c of mounted.splice(0)) unmount(c);
    document.body.innerHTML = '';
    vi.clearAllMocks();
  });

  it('pauses a running copy, then resumes it', async () => {
    api.backingCopy.mockResolvedValueOnce({
      copy: { pending: 1200, resumesAt: null, stalled: false, paused: false },
      uncopied: 0,
    });
    const target = await render();
    expect(text(target)).toContain('Copying 1,200 saves into it in the background.');

    api.backingCopy.mockResolvedValueOnce({
      copy: { pending: 1200, resumesAt: null, stalled: false, paused: true },
      uncopied: 0,
    });
    button(target, 'Pause')!.click();
    await settle();
    expect(api.backingCopy).toHaveBeenLastCalledWith('pauseCopy');
    expect(text(target)).toContain('Copying is paused, with 1,200 saves still to copy.');

    api.backingCopy.mockResolvedValueOnce({
      copy: { pending: 1200, resumesAt: null, stalled: false, paused: false },
      uncopied: 0,
    });
    button(target, 'Resume')!.click();
    await settle();
    expect(api.backingCopy).toHaveBeenLastCalledWith('resumeCopy');
    expect(button(target, 'Pause')).toBeTruthy();
  });

  it('offers to copy in saves that are not in the collection', async () => {
    api.backingCopy.mockResolvedValueOnce({ copy: null, uncopied: 40 });
    const target = await render();
    expect(text(target)).toContain("40 of your saves aren't in it yet");

    api.backingCopy.mockResolvedValueOnce({
      copy: { pending: 40, resumesAt: null, stalled: false, paused: false },
      uncopied: 0,
    });
    button(target, 'Copy them in')!.click();
    await settle();
    expect(api.backingCopy).toHaveBeenLastCalledWith('copyLibrary');
    expect(text(target)).toContain('Copying 40 saves');
  });
});
