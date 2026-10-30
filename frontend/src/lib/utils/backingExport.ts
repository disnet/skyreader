import { api, RateLimitError } from '$lib/services/api';

/** Saves per exportBatch call when copying named saves (the backend's MAX_LIMIT is 50). */
const RKEYS_PER_BATCH = 25;

const sleep = (seconds: number) => new Promise((resolve) => setTimeout(resolve, seconds * 1000));

/**
 * Copies saves not yet in the reader's Semble/Margin backing collection into
 * it, a batch at a time (POST /api/saved/backing `exportBatch`): the whole
 * Library when backing is turned on with "copy my Library", or just `rkeys`
 * (the saves an import added) after an import while backing is on. Returns
 * how many records it created.
 *
 * The cursor advances by `scanned` (not `exported`), so skipped or
 * already-backed saves still move it forward and the loop always terminates.
 *
 * A batch that comes back with `retryAfter` stopped to leave the reader's PDS
 * write budget alone: wait that long (telling `onPause` when it resumes, then
 * null once it has), and carry on from where it stopped.
 */
export async function copySavesToBacking(
  onProgress?: (current: number, total: number) => void,
  opts: { rkeys?: string[]; onPause?: (resumeAt: Date | null) => void } = {}
): Promise<number> {
  const exportBatch = async (offset: number) => {
    for (;;) {
      try {
        return opts.rkeys
          ? await api.exportSavesBatch(0, {
              rkeys: opts.rkeys.slice(offset, offset + RKEYS_PER_BATCH),
            })
          : await api.exportSavesBatch(offset);
      } catch (err) {
        if (!(err instanceof RateLimitError)) throw err;
        // Retry the same slice after the cooldown.
        await sleep(Math.min(err.retryAfter, 300));
      }
    }
  };

  let exported = 0;
  let offset = 0;
  const maxBatches = 4000; // safety backstop (≥ any real library at 25/batch)
  for (let i = 0; i < maxBatches; i++) {
    if (opts.rkeys && offset >= opts.rkeys.length) break;
    const batch = await exportBatch(offset);
    exported += batch.exported;
    const total = opts.rkeys ? opts.rkeys.length : batch.total;
    if (batch.retryAfter) {
      // Named rkeys go again as the same slice (what's copied is skipped);
      // an offset slice resumes past the rows it handled.
      if (!opts.rkeys) offset += batch.scanned;
      onProgress?.(Math.min(offset, total), total);
      opts.onPause?.(new Date(Date.now() + batch.retryAfter * 1000));
      await sleep(batch.retryAfter);
      opts.onPause?.(null);
      continue;
    }
    // Named rkeys advance by the slice sent: a deleted save scans as nothing.
    offset += opts.rkeys ? RKEYS_PER_BATCH : batch.scanned;
    onProgress?.(Math.min(offset, total), total);
    if (!opts.rkeys && (batch.scanned === 0 || offset >= batch.total)) break;
  }
  return exported;
}
