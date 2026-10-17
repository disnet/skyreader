/**
 * The one image open in the full-screen lightbox, if any. Reader bodies open it
 * through the `imageLightbox` action; `ImageLightbox.svelte` (mounted once in
 * the root layout) renders it.
 */
export interface LightboxImage {
  src: string;
  alt: string;
}

let current = $state<LightboxImage | null>(null);

export const lightbox = {
  get current() {
    return current;
  },
  open(image: LightboxImage) {
    current = image;
  },
  close() {
    current = null;
  },
};
