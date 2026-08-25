import { communityHighlightsStore } from '$lib/stores/communityHighlights.svelte';
import { findAllInDOM } from '$lib/utils/textSelector';

export function useCommunityHighlights(params: {
  contentEl: () => HTMLElement | undefined;
  itemUrl: () => string;
  enabled: () => boolean;
}) {
  let marks: HTMLElement[] = [];
  $effect(() => {
    const url = params.itemUrl();
    const enabled = params.enabled();
    const state = communityHighlightsStore.get(url);
    if (enabled && url && !state) communityHighlightsStore.load(url);
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
      const mark = document.createElement('mark');
      mark.className = 'community-highlight';
      mark.dataset.communityId = groups[i].id;
      const names = groups[i].people.map((p) => p.displayName || p.handle || 'A reader');
      mark.title = `${names.join(', ')} on margin.at`;
      try {
        if (range.startContainer === range.endContainer) range.surroundContents(mark);
        else {
          mark.appendChild(range.extractContents());
          range.insertNode(mark);
        }
        marks.push(mark);
      } catch {
        /* adornment only */
      }
    }
  }
  function attach() {
    apply();
  }
  function detach() {
    clear();
  }
  return { attach, detach, apply };
}
