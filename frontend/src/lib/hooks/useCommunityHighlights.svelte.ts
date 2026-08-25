import { communityHighlightsStore } from '$lib/stores/communityHighlights.svelte';
import { findAllInDOM } from '$lib/utils/textSelector';
import { wrapTextRange } from '$lib/utils/wrapTextRange';
import type { CommunityHighlightGroup } from '$lib/stores/communityHighlights.svelte';

export function useCommunityHighlights(params: {
  contentEl: () => HTMLElement | undefined;
  itemUrl: () => string;
  enabled: () => boolean;
}) {
  let marks: HTMLElement[] = [];
  let popoverState = $state<{ group: CommunityHighlightGroup; anchorRect: DOMRect } | null>(null);
  let wasEnabled = false;
  $effect(() => {
    const url = params.itemUrl();
    const enabled = params.enabled();
    const state = communityHighlightsStore.get(url);
    if (enabled && url && (!state || (!wasEnabled && state.failed))) {
      communityHighlightsStore.load(url, { force: state?.failed });
    }
    wasEnabled = enabled;
    // Reading groups here makes the decoration react when the lazy request
    // settles. Defer until Svelte has committed the current article body.
    void state?.groups;
    queueMicrotask(apply);
  });
  function clear() {
    for (const mark of marks) mark.replaceWith(...Array.from(mark.childNodes));
    marks = [];
    params.contentEl()?.normalize();
  }
  function handleClick(event: MouseEvent) {
    if (window.getSelection()?.toString()) return;
    const mark = (event.target as HTMLElement).closest<HTMLElement>('mark.community-highlight');
    if (!mark) return;
    const group = communityHighlightsStore
      .get(params.itemUrl())
      ?.groups.find((item) => item.id === mark.dataset.communityId);
    if (!group) return;
    event.preventDefault();
    event.stopPropagation();
    popoverState = { group, anchorRect: mark.getBoundingClientRect() };
  }
  function handleKeydown(event: KeyboardEvent) {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    handleClick(event as unknown as MouseEvent);
  }
  function apply() {
    clear();
    const el = params.contentEl();
    const url = params.itemUrl();
    if (!el || !url || !params.enabled()) return;
    communityHighlightsStore.load(url);
    const groups = communityHighlightsStore.get(url)?.groups ?? [];
    const ranges = findAllInDOM(
      groups.map((g) => g.selector),
      el
    );
    for (let i = ranges.length - 1; i >= 0; i--) {
      const range = ranges[i];
      if (!range) continue;
      const names = groups[i].people.map((p) => p.displayName || p.handle || 'A reader');
      marks.push(
        ...wrapTextRange(range, el, () => {
          const mark = document.createElement('mark');
          mark.className = 'community-highlight';
          mark.dataset.communityId = groups[i].id;
          mark.title = `${names.join(', ')} on margin.at`;
          mark.tabIndex = 0;
          mark.setAttribute('role', 'button');
          mark.setAttribute('aria-label', `Community highlight by ${names.join(', ')}`);
          return mark;
        })
      );
    }
  }
  function attach() {
    params.contentEl()?.addEventListener('click', handleClick);
    params.contentEl()?.addEventListener('keydown', handleKeydown);
    apply();
  }
  function detach() {
    params.contentEl()?.removeEventListener('click', handleClick);
    params.contentEl()?.removeEventListener('keydown', handleKeydown);
    popoverState = null;
    clear();
  }
  return {
    attach,
    detach,
    apply,
    get popoverState() {
      return popoverState;
    },
    get capped() {
      return communityHighlightsStore.get(params.itemUrl())?.capped ?? false;
    },
    closePopover: () => (popoverState = null),
    retry: () => communityHighlightsStore.load(params.itemUrl(), { force: true }),
  };
}
