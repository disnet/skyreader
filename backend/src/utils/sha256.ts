export async function sha256Hex(bytes: ArrayBuffer | Uint8Array): Promise<string> {
  return hexDigest(await crypto.subtle.digest('SHA-256', bytes));
}

/** A digest as lowercase hex, as saved_files.sha256 holds it. */
export function hexDigest(digest: ArrayBuffer): string {
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
