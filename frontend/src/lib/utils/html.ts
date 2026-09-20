/**
 * Escape the HTML special characters, so a plain string survives being spliced
 * into markup the reader renders with `{@html}`.
 *
 * Every renderer that builds HTML from record data needs this, so it lives in
 * one place rather than as a private copy per renderer — the copies had already
 * drifted (one escaped `'` as `&#39;`, the rest as `&#039;`).
 */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}
