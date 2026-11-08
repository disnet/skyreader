/**
 * Ask the browser to keep this site's storage (IndexedDB: the saved list,
 * cached article text, feeds) through storage pressure. Without it the storage
 * is "best effort": a browser short on space may clear it, and the next visit
 * starts over with a full first sync.
 *
 * Chromium and Safari decide silently (by engagement, or an installed app);
 * Firefox asks the reader with a permission prompt. Skyreader doesn't open
 * with a prompt about storage, so on Firefox this only asks when the answer
 * is already known to be yes.
 */
export async function requestPersistentStorage(): Promise<boolean> {
  try {
    const storage = typeof navigator !== 'undefined' ? navigator.storage : undefined;
    if (!storage?.persist || !storage.persisted) return false;
    if (await storage.persisted()) return true;
    if (/Firefox\//.test(navigator.userAgent)) {
      const status = await navigator.permissions
        ?.query({ name: 'persistent-storage' as PermissionName })
        .catch(() => null);
      if (status?.state !== 'granted') return false;
    }
    return await storage.persist();
  } catch {
    return false;
  }
}
