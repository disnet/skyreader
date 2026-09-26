import PostalMime, { type Email, type RawEmail } from 'postal-mime';
import type { FeedItem } from '../types';

/**
 * Turn one inbound newsletter email into a feed item.
 *
 * Pure: no D1, no env. The inbox plumbing (who the mail is for, whether their
 * plan covers it, which subscription it lands in) lives in services/newsletters.ts.
 *
 * The body is cleaned here only as far as the archive needs: email HTML is a
 * whole document (head, style blocks, a hidden preheader, tracking pixels), and
 * storing that verbatim would put CSS text and invisible preview copy into the
 * reader. Script safety is NOT this module's job — the reader sanitizes every
 * feed body (frontend/src/lib/utils/sanitize.ts), and a newsletter is a feed body.
 */

export interface ParsedNewsletter {
  /** Lowercased From address — the subscription key: one feed per sender. */
  sender: string;
  /** From display name, when the mail has one. */
  senderName: string | null;
  /** Where the newsletter lives on the web, best effort (drives the favicon). */
  siteUrl: string | null;
  item: FeedItem;
}

// Same length the ingest path derives previews at (routes/ingest.ts).
const SUMMARY_MAX_CHARS = 400;

// A Date header further ahead than this is a misconfigured sender, not a
// scheduled post; it would pin the item to the top of the reader until then.
const MAX_FUTURE_SKEW_MS = 60 * 60 * 1000;

// Anchor text that marks a newsletter's own web copy: "View in browser", "Read
// online", "View this email in your browser", "Web version", …
const WEB_VERSION_TEXT =
  /\b(?:view|read|open|see)\b[^<]{0,40}?\b(?:browser|online|on the web|web version|website)\b|\bweb version\b/i;

export async function parseNewsletterEmail(
  raw: RawEmail,
  receivedAtMs: number
): Promise<ParsedNewsletter | null> {
  const email = await PostalMime.parse(raw);
  const from = email.from && 'address' in email.from ? email.from : null;
  const sender = from?.address?.trim().toLowerCase();
  if (!sender || !sender.includes('@')) return null;
  const senderName = from?.name?.trim() || null;

  const html = email.html ? cleanEmailHtml(email.html) : '';
  const content = html || (email.text ? textToHtml(email.text) : '');
  const summary = summarize(email.text || stripTags(html));

  const item: FeedItem = {
    guid: await messageGuid(email, sender),
    url: findWebVersionUrl(email.html ?? '') ?? '',
    title: email.subject?.trim() || '(no subject)',
    author: senderName ?? undefined,
    content: content || undefined,
    summary: summary || undefined,
    publishedAt: new Date(sentAt(email, receivedAtMs)).toISOString(),
  };

  return { sender, senderName, siteUrl: siteUrlFor(email, sender), item };
}

/**
 * The Message-ID is the stable identity: a re-delivery of the same message is
 * then an idempotent re-ingest, not a duplicate. A message without one (rare,
 * but legal) gets a hash of what identifies it instead.
 */
async function messageGuid(email: Email, sender: string): Promise<string> {
  const messageId = email.messageId?.trim().replace(/^<|>$/g, '');
  if (messageId) return messageId;
  const payload = `${sender}|${email.subject ?? ''}|${email.date ?? ''}`;
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(payload));
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `email-${hex.slice(0, 32)}`;
}

function sentAt(email: Email, receivedAtMs: number): number {
  const parsed = email.date ? new Date(email.date).getTime() : NaN;
  if (Number.isNaN(parsed) || parsed > receivedAtMs + MAX_FUTURE_SKEW_MS) return receivedAtMs;
  return parsed;
}

function header(email: Email, key: string): string | null {
  return email.headers.find((h) => h.key === key)?.value ?? null;
}

/**
 * List-URL / List-Archive name the newsletter's home when the platform sets
 * them; otherwise the sender's own domain is the best guess we have.
 */
function siteUrlFor(email: Email, sender: string): string | null {
  for (const key of ['list-url', 'list-archive']) {
    const value = header(email, key);
    const url = value?.match(/<(https?:\/\/[^>]+)>/i)?.[1] ?? null;
    if (url && isHttpUrl(url)) return new URL(url).origin;
  }
  const domain = sender.split('@')[1];
  return domain ? `https://${domain}` : null;
}

export function findWebVersionUrl(html: string): string | null {
  const anchor = /<a\b[^>]*?\bhref\s*=\s*(["'])(.*?)\1[^>]*>([\s\S]*?)<\/a>/gi;
  for (const match of html.matchAll(anchor)) {
    const href = decodeEntities(match[2].trim());
    const text = stripTags(match[3]);
    if (WEB_VERSION_TEXT.test(text) && isHttpUrl(href)) return href;
  }
  return null;
}

/**
 * Reduce an email's HTML document to the part a reader shows: the body's inner
 * HTML, minus head/style/script, the hidden preheader and 1×1 tracking pixels.
 * Regex-based and best effort on purpose — the reader's sanitizer is the
 * safety boundary, this is only about not archiving noise.
 */
export function cleanEmailHtml(html: string): string {
  let out = html;
  const body = out.match(/<body\b[^>]*>([\s\S]*?)(?:<\/body>|$)/i);
  if (body) out = body[1];
  out = out
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(head|style|script|title|noscript)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<(?:meta|link|base)\b[^>]*>/gi, '')
    // Preheaders: the inbox-preview text newsletters hide with display:none.
    // Innermost-first so a hidden wrapper around ordinary markup still goes.
    .replace(
      /<(div|span|p|td|table)\b[^>]*style\s*=\s*(["'])[^"']*display\s*:\s*none[^"']*\2[^>]*>(?:(?!<\1\b)[\s\S])*?<\/\1>/gi,
      ''
    )
    // Tracking pixels: an <img> sized 0 or 1 in either dimension.
    .replace(/<img\b(?=[^>]*\b(?:width|height)\s*=\s*["']?[01](?:px)?["'\s/>])[^>]*>/gi, '')
    .replace(/<img\b(?=[^>]*style\s*=\s*["'][^"']*\b(?:width|height)\s*:\s*[01]px)[^>]*>/gi, '');
  return out.trim();
}

function textToHtml(text: string): string {
  return text
    .trim()
    .split(/\r?\n\s*\r?\n/)
    .map((para) => `<p>${linkify(escapeHtml(para)).replace(/\r?\n/g, '<br>')}</p>`)
    .join('\n');
}

function linkify(escaped: string): string {
  return escaped.replace(/\bhttps?:\/\/[^\s<>"']+/g, (url) => `<a href="${url}">${url}</a>`);
}

function summarize(text: string): string {
  const collapsed = text
    .replace(/\[[^\]]*\]\(https?:[^)]*\)/g, ' ')
    .replace(/<?https?:\/\/\S+>?/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (collapsed.length <= SUMMARY_MAX_CHARS) return escapeHtml(collapsed);
  const cut = collapsed.slice(0, SUMMARY_MAX_CHARS);
  const lastSpace = cut.lastIndexOf(' ');
  const head = lastSpace > SUMMARY_MAX_CHARS / 2 ? cut.slice(0, lastSpace) : cut;
  return `${escapeHtml(head.trimEnd())}…`;
}

function stripTags(html: string): string {
  return decodeEntities(
    html
      .replace(/<(style|script)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ')
      .replace(/<[^>]*>/g, ' ')
      .replace(/\s+/g, ' ')
  ).trim();
}

function decodeEntities(text: string): string {
  return text
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, code) => fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => fromCodePoint(parseInt(code, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

// An out-of-range reference in a sender's markup must not throw the whole parse.
function fromCodePoint(code: number): string {
  return Number.isInteger(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
}
