export const MAX_CURRENTS_IMAGE_BYTES = 19 * 1024 * 1024;

export type ImageFetchErrorCode = 'blocked' | 'too_large' | 'not_image' | 'upstream_failed';

export class ImageFetchError extends Error {
  constructor(
    public readonly code: ImageFetchErrorCode,
    message: string
  ) {
    super(message);
    this.name = 'ImageFetchError';
  }
}

function isBlockedHostname(hostname: string): boolean {
  // This is a defense-in-depth literal-host check, not DNS rebinding protection:
  // Workers egress supplies the network boundary and exposes no DNS resolution
  // API with which to validate every resolved address before fetching.
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal'))
    return true;
  if (
    host === '::1' ||
    host === '::' ||
    host.startsWith('fc') ||
    host.startsWith('fd') ||
    host.startsWith('fe8') ||
    host.startsWith('fe9') ||
    host.startsWith('fea') ||
    host.startsWith('feb')
  )
    return true;
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!match) return false;
  const octets = match.slice(1).map(Number);
  if (octets.some((n) => n > 255)) return true;
  const [a, b] = octets;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    a >= 224 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168)
  );
}

function sniffImageType(bytes: Uint8Array): string | null {
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.slice(0, 8).every((v, i) => v === [137, 80, 78, 71, 13, 10, 26, 10][i]))
    return 'image/png';
  if (
    String.fromCharCode(...bytes.slice(0, 6)) === 'GIF87a' ||
    String.fromCharCode(...bytes.slice(0, 6)) === 'GIF89a'
  )
    return 'image/gif';
  if (
    String.fromCharCode(...bytes.slice(0, 4)) === 'RIFF' &&
    String.fromCharCode(...bytes.slice(8, 12)) === 'WEBP'
  )
    return 'image/webp';
  return null;
}

export async function fetchImageForCurrents(
  imageUrl: string
): Promise<{ bytes: ArrayBuffer; contentType: string }> {
  let url: URL;
  try {
    url = new URL(imageUrl);
  } catch {
    throw new ImageFetchError('blocked', 'Image URL is invalid');
  }
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    isBlockedHostname(url.hostname)
  ) {
    throw new ImageFetchError('blocked', 'This image address cannot be fetched');
  }

  let response: Response | undefined;
  for (let redirects = 0; redirects <= 3; redirects += 1) {
    try {
      response = await fetch(url, { headers: { Accept: 'image/*' }, redirect: 'manual' });
    } catch {
      throw new ImageFetchError('upstream_failed', 'The image host could not be reached');
    }
    if (![301, 302, 303, 307, 308].includes(response.status)) break;
    const location = response.headers.get('location');
    if (!location || redirects === 3) {
      throw new ImageFetchError('upstream_failed', 'The image host redirected too many times');
    }
    url = new URL(location, url);
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      isBlockedHostname(url.hostname)
    ) {
      throw new ImageFetchError('blocked', 'The image redirected to a blocked address');
    }
  }
  if (!response)
    throw new ImageFetchError('upstream_failed', 'The image host could not be reached');
  if (!response.ok)
    throw new ImageFetchError('upstream_failed', `The image host returned ${response.status}`);
  const length = Number(response.headers.get('content-length'));
  if (Number.isFinite(length) && length > MAX_CURRENTS_IMAGE_BYTES)
    throw new ImageFetchError('too_large', 'Image is larger than 19 MiB');

  const reader = response.body?.getReader();
  if (!reader) throw new ImageFetchError('upstream_failed', 'The image response was empty');
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_CURRENTS_IMAGE_BYTES) {
      await reader.cancel();
      throw new ImageFetchError('too_large', 'Image is larger than 19 MiB');
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const declared = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
  const contentType = declared?.startsWith('image/') ? declared : sniffImageType(bytes);
  if (!contentType) throw new ImageFetchError('not_image', 'The address did not return an image');
  return { bytes: bytes.buffer, contentType };
}
