import { api, RateLimitError } from '$lib/services/api';

/**
 * Copies saves not yet in the reader's Semble/Margin backing collection into
 * it, a batch at a time (POST /api/saved/backing `exportBatch`): the whole
 * Library when backing is turned on with "copy my Library", or only imported
 * saves (`importedOnly`) after an import while backing is on. Returns how many
 * records it created.
 *
 * The cursor advances by `scanned` (not `exported`), so skipped or
 * already-backed saves still move it forward and the loop always terminates.
 */
export async function copySavesToBacking(
  onProgress?: (current: number, total: number) => void,
  opts: { importedOnly?: boolean } = {}
): Promise<number> {
  let exported = 0;
  let offset = 0;
  const maxBatches = 4000; // safety backstop (≥ any real library at 25/batch)
  for (let i = 0; i < maxBatches; i++) {
    let batch;
    try {
      batch = await api.exportSavesBatch(offset, opts);
    } catch (err) {
      if (err instanceof RateLimitError) {
        await new Promise((resolve) => setTimeout(resolve, Math.min(err.retryAfter, 300) * 1000));
        continue; // retry the same offset after the cooldown
      }
      throw err;
    }
    exported += batch.exported;
    offset += batch.scanned;
    onProgress?.(Math.min(offset, batch.total), batch.total);
    if (batch.scanned === 0 || offset >= batch.total) break;
  }
  return exported;
}
