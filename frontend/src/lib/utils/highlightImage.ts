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
    .replace(/[\u0300-\u036f]/g, '')
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

let busy = false;

function errorName(err: unknown): string | undefined {
  return (err as { name?: string } | null)?.name;
}

/**
 * Draw the passage as an image and save it. A toast shows while it draws;
 * failures end in one. A second tap while one is under way does nothing.
 */
export async function saveHighlightImage(
  quote: string,
  source: HighlightImageSource
): Promise<void> {
  if (!quote.trim() || busy) return;
  busy = true;
  const toast = toastStore.add('Drawing the image');
  try {
    let blob: Blob;
    try {
      ({ blob } = await renderTextShot(quote, {
        title: source.title,
        domain: source.url ? (domainFromUrl(source.url) ?? undefined) : undefined,
      }));
    } catch {
      toastStore.update(toast, 'error', 'Couldn’t make the image');
      return;
    }
    const name = highlightImageName(source.title, blob.type);

    if (prefersShareSheet() && typeof navigator.share === 'function') {
      const file = new File([blob], name, { type: blob.type });
      if (navigator.canShare?.({ files: [file] })) {
        const share = () => navigator.share({ files: [file] });
        try {
          await share();
          toastStore.remove(toast);
          return;
        } catch (err) {
          // Closing the sheet is a choice, not a failure.
          if (errorName(err) === 'AbortError') {
            toastStore.remove(toast);
            return;
          }
          // The tap's permission ran out while the image drew (Safari's is
          // short): a fresh tap on the toast opens the sheet.
          if (errorName(err) === 'NotAllowedError') {
            toastStore.update(toast, 'success', 'Image ready', {
              label: 'Share',
              run: () => void share().catch(() => {}),
            });
            return;
          }
          // Anything else: it downloads instead.
        }
      }
    }
    download(blob, name);
    toastStore.remove(toast);
  } finally {
    busy = false;
  }
}
