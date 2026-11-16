// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushSync } from 'svelte';
import { useSavePanel } from './useSavePanel.svelte';

function setup(init: { isSaved?: boolean; shelfSave?: unknown; opensPanel?: boolean } = {}) {
  const state = $state({
    isSaved: init.isSaved ?? false,
    shelfSave: init.shelfSave ?? null,
    opensPanel: init.opensPanel ?? true,
  });
  const onToggleSave = vi.fn();
  const focusControl = vi.fn();
  let panel!: ReturnType<typeof useSavePanel>;
  const cleanup = $effect.root(() => {
    panel = useSavePanel({
      isSaved: () => state.isSaved,
      shelfSave: () => state.shelfSave,
      onToggleSave: () => onToggleSave,
      opensPanel: () => state.opensPanel,
      focusControl,
    });
  });
  flushSync();
  return { state, panel, onToggleSave, focusControl, cleanup };
}

afterEach(() => vi.useRealTimers());

describe('useSavePanel', () => {
  it('saves and opens the panel, which waits for the save to land', () => {
    vi.useFakeTimers();
    const { state, panel, onToggleSave, cleanup } = setup();
    panel.press();
    flushSync();
    expect(onToggleSave).toHaveBeenCalledOnce();
    expect(panel.open).toBe(true);
    state.isSaved = true;
    state.shelfSave = { rkey: 'a' };
    flushSync();
    vi.advanceTimersByTime(10_000);
    flushSync();
    expect(panel.open).toBe(true);
    cleanup();
  });

  it('closes when a save never lands', () => {
    vi.useFakeTimers();
    const { panel, cleanup } = setup();
    panel.press();
    flushSync();
    expect(panel.open).toBe(true);
    vi.advanceTimersByTime(8000);
    flushSync();
    expect(panel.open).toBe(false);
    cleanup();
  });

  it('opens a saved item without toggling, and a second press closes it', () => {
    const { panel, onToggleSave, cleanup } = setup({ isSaved: true, shelfSave: { rkey: 'a' } });
    panel.press();
    flushSync();
    expect(panel.open).toBe(true);
    expect(onToggleSave).not.toHaveBeenCalled();
    panel.press();
    expect(panel.open).toBe(false);
    cleanup();
  });

  it('is a plain toggle when it opens no panel', () => {
    const { panel, onToggleSave, cleanup } = setup({ isSaved: true, opensPanel: false });
    panel.press();
    flushSync();
    expect(onToggleSave).toHaveBeenCalledOnce();
    expect(panel.open).toBe(false);
    cleanup();
  });

  it('closes when unsaved some other way', () => {
    const { state, panel, cleanup } = setup({ isSaved: true, shelfSave: { rkey: 'a' } });
    panel.press();
    flushSync();
    state.isSaved = false;
    state.shelfSave = null;
    flushSync();
    expect(panel.open).toBe(false);
    cleanup();
  });

  it('toggle and Remove put the panel away; Remove hands focus back', () => {
    const { panel, onToggleSave, focusControl, cleanup } = setup({
      isSaved: true,
      shelfSave: { rkey: 'a' },
    });
    panel.press();
    panel.toggle();
    expect(panel.open).toBe(false);
    panel.press();
    panel.unsave();
    expect(panel.open).toBe(false);
    expect(onToggleSave).toHaveBeenCalledTimes(2);
    expect(focusControl).toHaveBeenCalledOnce();
    cleanup();
  });
});
