/**
 * True for a web address: one that parses as a URL and is http or https.
 * (The workspace shell protocol keeps its own prefix check, workspace/protocol.ts,
 * because it mirrors the protocol's definition.)
 */
export function isHttpUrl(value: string | null | undefined): value is string {
  if (!value) return false;
  try {
    const { protocol } = new URL(value);
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}
