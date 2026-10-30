/**
 * Third-party credentials the Worker has to use while the reader is away (a
 * Zotero API key), sealed with AES-GCM under a Worker secret so a D1 read, an
 * export or a backup doesn't hand them out. The reader's DID is the associated
 * data: a sealed value copied onto another reader's row won't open.
 *
 * Sealed form: `v1:<iv>:<ciphertext>`, both base64url. Losing the secret means
 * every sealed value is unreadable, and those readers connect again.
 */

const VERSION = 'v1';

let cached: { secret: string; key: Promise<CryptoKey> } | null = null;

function keyFor(secret: string): Promise<CryptoKey> {
  if (cached?.secret !== secret) {
    const key = crypto.subtle
      .digest('SHA-256', new TextEncoder().encode(secret))
      .then((raw) => crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']));
    cached = { secret, key };
  }
  return cached.key;
}

const b64 = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

const unb64 = (text: string) =>
  Uint8Array.from(atob(text.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));

export async function sealSecret(
  secret: string,
  owner: string,
  plaintext: string
): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const sealed = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(owner) },
    await keyFor(secret),
    new TextEncoder().encode(plaintext)
  );
  return `${VERSION}:${b64(iv)}:${b64(new Uint8Array(sealed))}`;
}

/** The plaintext, or null when it was sealed under another secret, for another owner, or not at all. */
export async function openSecret(
  secret: string,
  owner: string,
  sealed: string
): Promise<string | null> {
  const [version, iv, data] = sealed.split(':');
  if (version !== VERSION || !iv || !data) return null;
  try {
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: unb64(iv), additionalData: new TextEncoder().encode(owner) },
      await keyFor(secret),
      unb64(data)
    );
    return new TextDecoder().decode(plain);
  } catch {
    return null;
  }
}
