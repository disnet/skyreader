import { looksLikeZip } from './epub';
import { hexDigest } from '../utils/sha256';

/**
 * A kept original's bytes on their way into the store (services/saved-file-store.ts),
 * checked as they pass so the Worker never holds the whole file: uploads and the
 * originals of saves by link (routes/saved-pdf.ts), and linked books staged for
 * their save (services/linked-originals.ts).
 */

// A PDF starts with `%PDF-`, though the spec lets junk precede it within the
// first kilobyte (and some generators do).
export const PDF_SIGNATURE_WINDOW = 1024;

export function looksLikePdf(bytes: Uint8Array): boolean {
  const head = bytes.subarray(0, PDF_SIGNATURE_WINDOW);
  const sig = [0x25, 0x50, 0x44, 0x46, 0x2d];
  outer: for (let i = 0; i + sig.length <= head.length; i++) {
    for (let j = 0; j < sig.length; j++) {
      if (head[i + j] !== sig[j]) continue outer;
    }
    return true;
  }
  return false;
}

/** Why a file was turned away on its way into the store. */
export class FileRejected extends Error {
  constructor(readonly reason: 'too_large' | 'wrong_type' | 'empty') {
    super(`file rejected: ${reason}`);
    this.name = 'FileRejected';
  }
}

/**
 * A file's bytes on their way to the store, checked as they pass, so it is
 * never held whole: past `maxBytes`, empty, or not starting like a `kind`, the
 * stream errors with FileRejected and the store keeps nothing. `done` gives the
 * size and SHA-256 once the last byte has gone through.
 */
export function checkedFile(
  body: ReadableStream<Uint8Array>,
  kind: 'pdf' | 'epub',
  maxBytes: number
) {
  const digest = new crypto.DigestStream('SHA-256');
  const hasher = digest.getWriter();
  const head = new Uint8Array(PDF_SIGNATURE_WINDOW);
  let headBytes = 0;
  let checked = false;
  let size = 0;
  const checkHead = () => {
    checked = true;
    const bytes = head.subarray(0, headBytes);
    if (!(kind === 'pdf' ? looksLikePdf(bytes) : looksLikeZip(bytes))) {
      throw new FileRejected('wrong_type');
    }
  };
  const reader = body.getReader();
  const step = async (controller: ReadableStreamDefaultController<Uint8Array>) => {
    const { done, value } = await reader.read();
    if (done) {
      if (size === 0) throw new FileRejected('empty');
      if (!checked) checkHead();
      await hasher.close();
      return controller.close();
    }
    size += value.byteLength;
    if (size > maxBytes) throw new FileRejected('too_large');
    if (!checked) {
      const n = Math.min(value.byteLength, head.length - headBytes);
      head.set(value.subarray(0, n), headBytes);
      headBytes += n;
      if (headBytes === head.length) checkHead();
    }
    await hasher.write(value);
    controller.enqueue(value);
  };
  // Pulled by the store, so it reads the source only as fast as the store writes.
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        await step(controller);
      } catch (err) {
        // Refused or failed: stop pulling the source too.
        await reader.cancel(err).catch(() => {});
        throw err;
      }
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
  const done = async () => ({ size, sha256: hexDigest(await digest.digest) });
  return { stream, done };
}
