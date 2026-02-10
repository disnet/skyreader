/**
 * Get a favicon URL for a given website URL using Google's favicon service.
 * @param url - The website URL to get a favicon for
 * @param size - The size of the favicon in pixels (default: 32)
 * @returns The favicon URL, or empty string if the URL is invalid
 */
export function getFaviconUrl(url: string, size: number = 32): string {
  try {
    const domain = new URL(url).hostname;
    return `https://www.google.com/s2/favicons?domain=${domain}&sz=${size}`;
  } catch {
    return '';
  }
}
