import { libraryExportUrl } from '$lib/services/api';

export type LibraryExportFormat = 'markdown' | 'bibtex';

const EXTENSIONS: Record<LibraryExportFormat, string> = { markdown: 'md', bibtex: 'bib' };

/**
 * Download the reader's saves, highlights and notes as Markdown or BibTeX.
 * Fetched rather than navigated to, so a failure stays on the page as an
 * error instead of replacing it with the API's JSON.
 */
export async function downloadLibraryExport(format: LibraryExportFormat): Promise<void> {
  if (typeof navigator !== 'undefined' && !navigator.onLine) {
    throw new Error('Exporting needs a connection.');
  }
  const response = await fetch(libraryExportUrl(format), { credentials: 'include' });
  if (response.status === 429) throw new Error('Too many exports just now. Try again in a minute.');
  if (!response.ok) throw new Error('The export didn’t work. Try again.');
  const blob = await response.blob();
  const date = new Date().toISOString().slice(0, 10);
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `skyreader-export-${date}.${EXTENSIONS[format]}`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // Safari can still be reading the blob when click() returns.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
