/**
 * Svelte action that opens an article's images in the full-screen lightbox.
 *
 * One delegated click listener on the rendered body (the HTML is `{@html}`, so
 * there's nothing to bind per image). It runs before Svelte's delegated
 * `onclick` handlers at the root, so stopping the event here keeps a tap on an
 * image from also expanding a card or turning a page.
 *
 * Left alone: icons and emoji (too small to be worth enlarging), an image that
 * links somewhere other than an image (the link wins), and a click that ends a
 * drag-select (the selection is for highlighting).
 */
import { lightbox } from '$lib/stores/lightbox.svelte';

export interface ImageLightboxOptions {
  /** False while a tap on the body means something else (a clamped preview). */
  enabled?: boolean;
}

/** Below this rendered size an image is an icon or an emoji, not a picture. */
const MIN_SIZE_PX = 48;

const IMAGE_HREF = /\.(avif|gif|jpe?g|png|svg|webp)(?:[?#]|$)/i;

export function imageLightbox(node: HTMLElement, options: ImageLightboxOptions = {}) {
  let enabled = options.enabled ?? true;

  function onClick(e: MouseEvent) {
    if (!enabled || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const img = (e.target as HTMLElement).closest('img');
    if (!img || !node.contains(img)) return;
    const rect = img.getBoundingClientRect();
    if (rect.width < MIN_SIZE_PX && rect.height < MIN_SIZE_PX) return;
    const selection = window.getSelection();
    if (selection && !selection.isCollapsed && selection.toString().trim().length > 0) return;

    // An image wrapped in a link to its own full-size file opens that file;
    // one linking anywhere else follows its link.
    const link = img.closest('a');
    let src = img.currentSrc || img.src;
    if (link) {
      if (!IMAGE_HREF.test(link.href)) return;
      src = link.href;
    }
    if (!src) return;

    e.preventDefault();
    e.stopPropagation();
    lightbox.open({ src, alt: img.alt });
  }

  node.addEventListener('click', onClick);
  node.classList.add('image-lightbox');
  node.classList.toggle('image-lightbox-off', !enabled);

  return {
    update(next: ImageLightboxOptions = {}) {
      enabled = next.enabled ?? true;
      node.classList.toggle('image-lightbox-off', !enabled);
    },
    destroy() {
      node.removeEventListener('click', onClick);
      node.classList.remove('image-lightbox', 'image-lightbox-off');
    },
  };
}
