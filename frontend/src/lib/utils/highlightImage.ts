/**
 * A highlight's image, kept as a file: the same text shot a Bluesky post
 * carries (`renderTextShot`), handed to the reader to keep or send on.
 *
 * On a touch device the share sheet is the way to keep it — iOS has no
 * Downloads folder to speak of, and "Save Image" there puts it in Photos.
 * Everywhere else, or where a file can't be shared, it downloads.
 */
import { renderTextShot } from '$lib/utils/textShot';
import { domainFromUrl } from '$lib/utils/highlightSource';
import { toastStore } from '$lib/stores/toast.svelte';

export interface HighlightImageSource {
  url?: string | null;
  title?: string;
}

/** A file name from the article's title: `skyreader-quote-<title>.png`. */
export function highlightImageName(title: string | undefined, type: string): string {
  const ext = type === 'image/jpeg' ? 'jpg' : 'png';
  const slug = (title ?? '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/, '');
  return `skyreader-quote${slug ? `-${slug}` : ''}.${ext}`;
}

function prefersShareSheet(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(hover: none) and (pointer: coarse)').matches
  );
}

function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoked later, not at once: some browsers start reading the blob only
  // after the click has returned.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/** Draw the passage as an image and save it. Failures end in a toast. */
export async function saveHighlightImage(
  quote: string,
  source: HighlightImageSource
): Promise<void> {
  if (!quote.trim()) return;
  let blob: Blob;
  try {
    ({ blob } = await renderTextShot(quote, {
      title: source.title,
      domain: source.url ? (domainFromUrl(source.url) ?? undefined) : undefined,
    }));
  } catch {
    toastStore.update(toastStore.add(''), 'error', 'Couldn’t make the image');
    return;
  }
  const name = highlightImageName(source.title, blob.type);

  if (prefersShareSheet() && typeof navigator.share === 'function') {
    const file = new File([blob], name, { type: blob.type });
    if (navigator.canShare?.({ files: [file] })) {
      try {
        await navigator.share({ files: [file] });
        return;
      } catch (err) {
        // Closing the sheet is a choice, not a failure.
        if ((err as DOMException)?.name === 'AbortError') return;
        // Anything else (the tap's permission lapsed while drawing, say):
        // download it instead.
      }
    }
  }
  download(blob, name);
}
