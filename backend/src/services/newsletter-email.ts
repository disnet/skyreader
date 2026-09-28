import PostalMime, { addressParser, type Email, type RawEmail } from 'postal-mime';
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

// Subject prefixes mail clients add when the reader hits Forward: Fwd/Fw, and
// the common localized ones (WG, TR, RV, Enc, VS, Doorst).
const FORWARD_SUBJECT = /^\s*(?:fwd?|wg|tr|rv|enc|vs|doorst)\s*:\s*/i;

// The line a client puts above the original message's headers in an inline
// forward: Gmail's "---------- Forwarded message ---------", Thunderbird's
// "-------- Forwarded Message --------", Outlook's "-----Original Message-----"
// or a rule of underscores, Apple Mail's "Begin forwarded message:".
const FORWARD_MARKER =
  /^[ \t>]*(?:-{2,}\s*(?:forwarded message|original message)\s*-{2,}|begin forwarded message:|_{10,})[ \t]*$/im;

export async function parseNewsletterEmail(
  raw: RawEmail,
  receivedAtMs: number
): Promise<ParsedNewsletter | null> {
  const email = await PostalMime.parse(raw);

  // A forward's From is the reader, not the newsletter. Keying on it would pile
  // every forwarded issue into one source named after them — and deleting that
  // source would block their own address. So a forward is filed under the
  // sender of the message it carries.
  if (FORWARD_SUBJECT.test(email.subject ?? '')) {
    const attached = email.attachments.find((a) => a.mimeType === 'message/rfc822');
    if (attached) {
      const inner = await parseNewsletterEmail(attached.content, receivedAtMs);
      if (inner) return inner;
    }
    const inline = await parseInlineForward(email, receivedAtMs);
    if (inline) return inline;
  }

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
    publishedAt: new Date(sentAt(email.date, receivedAtMs)).toISOString(),
  };

  return { sender, senderName, siteUrl: siteUrlFor(email, sender), item };
}

interface ForwardedHeaders {
  sender: string;
  senderName: string | null;
  subject: string | null;
  date: string | null;
  /** The forward as lines, and where the original message's body starts. */
  lines: string[];
  bodyStart: number;
}

/**
 * The original sender, subject and date out of an inline forward's quoted
 * header block ("From: … / Date: … / Subject: …" under the client's marker).
 * Null when there is no such block or it names no sender address.
 */
function findForwardedHeaders(text: string): ForwardedHeaders | null {
  const lines = text.split(/\r?\n/);
  const markerAt = lines.findIndex((line) => FORWARD_MARKER.test(line));
  if (markerAt < 0) return null;

  const fields: Record<string, string> = {};
  let i = markerAt + 1;
  while (i < lines.length && !unquote(lines[i])) i++; // Apple Mail leaves a gap
  for (; i < lines.length; i++) {
    const line = unquote(lines[i]);
    const field = line.match(/^([a-z][a-z -]*?)\s*:\s*(.*)$/i);
    if (!field) break;
    fields[field[1].toLowerCase()] ??= field[2].trim();
  }
  if (!fields.from) return null;

  const mailbox = parseMailbox(fields.from);
  if (!mailbox) return null;
  return {
    ...mailbox,
    subject: fields.subject || null,
    date: fields.date || fields.sent || null,
    lines,
    bodyStart: i,
  };
}

async function parseInlineForward(
  email: Email,
  receivedAtMs: number
): Promise<ParsedNewsletter | null> {
  const forwarded = findForwardedHeaders(email.text ?? (email.html ? htmlToText(email.html) : ''));
  if (!forwarded) return null;
  const { sender, senderName } = forwarded;
  const bodyText = forwarded.lines.slice(forwarded.bodyStart).map(unquote).join('\n').trim();
  // The HTML keeps the whole forward; only the attribution block the big
  // clients mark up (Gmail's gmail_attr, Outlook's divRplyFwdMsg) is removed.
  const html = email.html
    ? cleanEmailHtml(
        removeElements(email.html, /^div$/i, (tag) =>
          /\bclass\s*=\s*["'][^"']*\bgmail_attr\b|\bid\s*=\s*["']?divRplyFwdMsg\b/i.test(tag)
        )
      )
    : '';
  const content = html || (bodyText ? textToHtml(bodyText) : '');
  const title =
    forwarded.subject?.trim() ||
    email.subject?.replace(FORWARD_SUBJECT, '').trim() ||
    '(no subject)';

  const item: FeedItem = {
    guid: await messageGuid(email, sender),
    url: findWebVersionUrl(email.html ?? '') ?? '',
    title,
    author: senderName ?? undefined,
    content: content || undefined,
    summary: summarize(bodyText || stripTags(html)) || undefined,
    publishedAt: new Date(
      sentAt(forwarded.date?.replace(/\s+at\s+/i, ' ') ?? email.date, receivedAtMs)
    ).toISOString(),
  };
  // The forward's own List-* headers belong to the reader's mail, not the
  // newsletter, so the site is the original sender's domain.
  return { sender, senderName, siteUrl: `https://${sender.split('@')[1]}`, item };
}

function unquote(line: string): string {
  return line.replace(/^(?:\s*>)+/, '').trim();
}

/** `Name <a@b>`, `a@b`, and Outlook's `Name [mailto:a@b]` → its parts. */
function parseMailbox(value: string): { sender: string; senderName: string | null } | null {
  const normalized = value.replace(/\[mailto:([^\]]+)\]/i, '<$1>').replace(/<mailto:/i, '<');
  const parsed = addressParser(normalized)[0];
  const address =
    parsed && 'address' in parsed && parsed.address
      ? parsed.address
      : normalized.match(/[^\s<>"'\[\]]+@[^\s<>"'\[\]]+\.[a-z]{2,}/i)?.[0];
  const sender = address?.trim().toLowerCase();
  if (!sender || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(sender)) return null;
  const name = parsed?.name?.trim().replace(/^["']|["']$/g, '');
  return { sender, senderName: name || null };
}

/** HTML to plain lines, keeping the block breaks a header block is laid out with. */
function htmlToText(html: string): string {
  return decodeEntities(
    html
      .replace(/<(style|script|head)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
      .replace(/<br\b[^>]*>|<\/(?:p|div|tr|li|blockquote|h[1-6])\s*>/gi, '\n')
      .replace(/<[^>]*>/g, '')
      .replace(/[ \t]+/g, ' ')
  );
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

function sentAt(date: string | null | undefined, receivedAtMs: number): number {
  const parsed = date ? new Date(date).getTime() : NaN;
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
    // Tracking pixels: an <img> sized 0 or 1 in either dimension.
    .replace(/<img\b(?=[^>]*\b(?:width|height)\s*=\s*["']?[01](?:px)?["'\s/>])[^>]*>/gi, '')
    .replace(/<img\b(?=[^>]*style\s*=\s*["'][^"']*\b(?:width|height)\s*:\s*[01]px)[^>]*>/gi, '');
  // Preheaders: the inbox-preview text newsletters hide with display:none.
  out = removeElements(out, /^(?:div|span|p|td|table|center)$/i, (tag) =>
    /display\s*:\s*none/i.test(styleOf(tag))
  );
  return out.trim();
}

// One tag, open or close; quoted attribute values may hold `>` or the other quote.
const TAG = /<(\/?)([a-z][a-z0-9]*)\b(?:[^>"']|"[^"]*"|'[^']*')*>/gi;

function styleOf(tag: string): string {
  const style = tag.match(/\sstyle\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i);
  return style ? (style[1] ?? style[2] ?? style[3]) : '';
}

/**
 * Remove every element whose name matches `names` and whose opening tag passes
 * `test`, along with everything inside it. The close is found by counting
 * nesting, so a hidden <div> holding more <div>s goes whole and the markup
 * after it stays. One forward pass; an element never closed stops it, leaving
 * that element and everything after it as they were.
 */
function removeElements(html: string, names: RegExp, test: (openTag: string) => boolean): string {
  const tag = new RegExp(TAG.source, 'gi');
  let out = '';
  let kept = 0;
  let open: RegExpExecArray | null;
  while ((open = tag.exec(html))) {
    if (open[1] || !names.test(open[2]) || !test(open[0])) continue;
    const end = matchingCloseEnd(html, open[2].toLowerCase(), tag.lastIndex);
    if (end < 0) break;
    out += html.slice(kept, open.index);
    kept = tag.lastIndex = end;
  }
  return out + html.slice(kept);
}

function matchingCloseEnd(html: string, name: string, from: number): number {
  const tag = new RegExp(TAG.source, 'gi');
  tag.lastIndex = from;
  let depth = 1;
  let match: RegExpExecArray | null;
  while ((match = tag.exec(html))) {
    if (match[2].toLowerCase() !== name || match[0].endsWith('/>')) continue;
    depth += match[1] ? -1 : 1;
    if (depth === 0) return tag.lastIndex;
  }
  return -1;
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
