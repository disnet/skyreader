import { describe, expect, it, vi } from 'vitest';
import { keyboardStore } from './keyboard.svelte';

function press(key: string) {
  keyboardStore.handleKeydown(new KeyboardEvent('keydown', { key }));
}

describe('keyboardStore.coverList', () => {
  it('stands list-only shortcuts down while the list is covered, and only those', () => {
    const next = vi.fn();
    const bigger = vi.fn();
    keyboardStore.register({
      key: 'j',
      description: '',
      category: '',
      action: next,
      listOnly: true,
    });
    keyboardStore.register({ key: '=', description: '', category: '', action: bigger });

    const uncover = keyboardStore.coverList();
    press('j');
    press('=');
    expect(next).not.toHaveBeenCalled();
    expect(bigger).toHaveBeenCalledTimes(1);

    // Nested covers (a reader opened from search over a reader) count down.
    const uncoverInner = keyboardStore.coverList();
    uncoverInner();
    uncoverInner();
    press('j');
    expect(next).not.toHaveBeenCalled();

    uncover();
    press('j');
    expect(next).toHaveBeenCalledTimes(1);

    keyboardStore.unregister('j');
    keyboardStore.unregister('=');
  });
});
