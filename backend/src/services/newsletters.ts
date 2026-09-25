import type { Env } from '../types';
import { computeContentHash, ingestBatch } from '../routes/ingest';
import { getUserTierLimits } from './user-tier';
import { parseNewsletterEmail } from './newsletter-email';
import { generateTid } from '../utils/tid';
import { log, serializeError } from '../utils/logger';

/**
 * Email newsletters: a Supporter feature (TierLimits.newsletterInbox).
 *
 * Each reader gets one private address, `<token>@<NEWSLETTER_EMAIL_DOMAIN>`.
 * Cloudflare Email Routing hands every message for that domain to the Worker's
 * `email()` handler (src/index.ts), which lands it here: one subscription per
 * sender, one feed item per message, written into the same `feed_items` archive
 * the crawler fills. From there the timeline serves it like any feed.
 *
 * A newsletter subscription is PRIVATE and LOCAL-ONLY, unlike every other kind:
 *   - its items came to one person's inbox (often with personal unsubscribe and
 *     tracking links in them), so no one else may read its feed;
 *   - it is never written to the PDS — the Atmosphere copy would publish which
 *     newsletters someone reads, and the record would be meaningless to any
 *     other app anyway;
 *   - it is never crawled: `newsletter:` is not a fetchable URL.
 * `isNewsletterSubscription` is the one test every one of those paths applies.
 * See docs/plans/EMAIL_NEWSLETTERS.md.
 */

export const NEWSLETTER_SOURCE_TYPE = 'email.newsletter';
const FEED_URL_PREFIX = 'newsletter:';

// Larger than any real newsletter (image-heavy issues run a few hundred KB of
// HTML; images are links, not attachments), small enough that one message
// can't cost much to parse.
export const MAX_NEWSLETTER_EMAIL_BYTES = 5 * 1024 * 1024;

// Messages one inbox may ingest per UTC day. A daily-issue reader with dozens
// of subscriptions stays far below it; a leaked address being flooded stops here.
export const MAX_NEWSLETTER_EMAILS_PER_DAY = 200;

// Local part alphabet: lowercase, no look-alikes (0/o, 1/l), so an address read
// aloud or retyped survives. 12 characters ≈ 60 bits: not guessable.
const TOKEN_ALPHABET = 'abcdefghijkmnpqrstuvwxyz23456789';
const TOKEN_LENGTH = 12;

export function isNewsletterFeedUrl(feedUrl: string | null | undefined): boolean {
  return !!feedUrl && feedUrl.toLowerCase().startsWith(FEED_URL_PREFIX);
}

/**
 * True for a subscription row that must stay private, local and uncrawled.
 * Either half is enough: a row claiming the source type, or any row naming a
 * `newsletter:` feed — the latter is what stops a forged subscription (a PDS
 * record, an API call) from pointing at someone else's inbox.
 */
export function isNewsletterSubscription(
  feedUrl: string | null | undefined,
  sourceType: string | null | undefined
): boolean {
  return sourceType === NEWSLETTER_SOURCE_TYPE || isNewsletterFeedUrl(feedUrl);
}

export function newsletterFeedUrl(inboxId: string, sender: string): string {
  return `${FEED_URL_PREFIX}${inboxId}/${sender.toLowerCase()}`;
}

/** `newsletter:<inbox_id>/<sender>` → its parts, or null for anything else. */
export function parseNewsletterFeedUrl(
  feedUrl: string
): { inboxId: string; sender: string } | null {
  if (!isNewsletterFeedUrl(feedUrl)) return null;
  const rest = feedUrl.slice(FEED_URL_PREFIX.length);
  const slash = rest.indexOf('/');
  if (slash <= 0 || slash === rest.length - 1) return null;
  return { inboxId: rest.slice(0, slash), sender: rest.slice(slash + 1) };
}

/** The configured inbound domain, or null when the feature is off here. */
export function newsletterDomain(env: Env): string | null {
  const domain = (env.NEWSLETTER_EMAIL_DOMAIN as string | undefined)?.trim().toLowerCase();
  return domain || null;
}

/**
 * May this user read this newsletter feed? Only the owner of the inbox it
 * arrived in. Checked against the inbox table rather than the subscription, so
 * the answer holds however a subscription row came to exist.
 */
export async function ownsNewsletterFeed(
  env: Env,
  userDid: string | null | undefined,
  feedUrl: string
): Promise<boolean> {
  const parsed = parseNewsletterFeedUrl(feedUrl);
  if (!parsed || !userDid) return false;
  const row = await env.DB.prepare(
    'SELECT 1 AS ok FROM newsletter_inboxes WHERE user_did = ? AND inbox_id = ?'
  )
    .bind(userDid, parsed.inboxId)
    .first<{ ok: number }>();
  return !!row;
}

function randomToken(length: number, alphabet: string): string {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  let out = '';
  for (const byte of bytes) out += alphabet[byte % alphabet.length];
  return out;
}

function randomHex(bytes: number): string {
  return [...crypto.getRandomValues(new Uint8Array(bytes))]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export interface NewsletterInbox {
  inboxId: string;
  token: string;
  createdAt: number;
  rotatedAt: number | null;
  lastReceivedAt: number | null;
}

export async function getNewsletterInbox(
  env: Env,
  userDid: string
): Promise<NewsletterInbox | null> {
  const row = await env.DB.prepare(
    `SELECT inbox_id, address_token, created_at, rotated_at, last_received_at
       FROM newsletter_inboxes WHERE user_did = ?`
  )
    .bind(userDid)
    .first<{
      inbox_id: string;
      address_token: string;
      created_at: number;
      rotated_at: number | null;
      last_received_at: number | null;
    }>();
  if (!row) return null;
  return {
    inboxId: row.inbox_id,
    token: row.address_token,
    createdAt: row.created_at,
    rotatedAt: row.rotated_at,
    lastReceivedAt: row.last_received_at,
  };
}

/**
 * Issue the user's address, or give them a fresh one (`rotate`). Rotation keeps
 * `inbox_id`, so every newsletter already received stays where it is; only the
 * old address stops accepting mail.
 */
export async function issueNewsletterInbox(
  env: Env,
  userDid: string,
  rotate: boolean
): Promise<NewsletterInbox> {
  const existing = await getNewsletterInbox(env, userDid);
  if (existing && !rotate) return existing;

  const token = randomToken(TOKEN_LENGTH, TOKEN_ALPHABET);
  if (existing) {
    await env.DB.prepare(
      `UPDATE newsletter_inboxes SET address_token = ?, rotated_at = unixepoch() WHERE user_did = ?`
    )
      .bind(token, userDid)
      .run();
  } else {
    // OR IGNORE: two tabs issuing at once must both come back with the one row.
    await env.DB.prepare(
      `INSERT OR IGNORE INTO newsletter_inboxes (user_did, inbox_id, address_token) VALUES (?, ?, ?)`
    )
      .bind(userDid, randomHex(8), token)
      .run();
  }
  return (await getNewsletterInbox(env, userDid))!;
}

export function newsletterAddress(token: string, domain: string): string {
  return `${token}@${domain}`;
}

/** The token a recipient address carries, when it's addressed to our domain. */
export function tokenFromRecipient(recipient: string, domain: string): string | null {
  const address = recipient.trim().toLowerCase();
  const at = address.lastIndexOf('@');
  if (at <= 0 || address.slice(at + 1) !== domain) return null;
  // Plus-addressing (token+anything@) still reaches the inbox: some signup
  // forms are happier with a tag, and the reader may use one to tell lists apart.
  const local = address.slice(0, at).split('+')[0];
  return local || null;
}

export async function listBlockedSenders(
  env: Env,
  userDid: string
): Promise<Array<{ sender: string; blockedAt: number }>> {
  const rows = await env.DB.prepare(
    `SELECT sender, created_at FROM newsletter_blocked_senders
      WHERE user_did = ? ORDER BY created_at DESC LIMIT 500`
  )
    .bind(userDid)
    .all<{ sender: string; created_at: number }>();
  return rows.results.map((row) => ({ sender: row.sender, blockedAt: row.created_at }));
}

/**
 * Statements that stop future mail from the senders behind these newsletter
 * feeds. Called when the reader deletes a newsletter subscription: that can't
 * unsubscribe at the source, so without a block the next issue would bring the
 * subscription straight back.
 */
export function blockSenderStatements(
  env: Env,
  userDid: string,
  feedUrls: Array<string | null | undefined>
): D1PreparedStatement[] {
  return feedUrls.flatMap((feedUrl) => {
    const parsed = feedUrl ? parseNewsletterFeedUrl(feedUrl) : null;
    if (!parsed) return [];
    return [
      env.DB.prepare(
        `INSERT OR IGNORE INTO newsletter_blocked_senders (user_did, sender) VALUES (?, ?)`
      ).bind(userDid, parsed.sender),
    ];
  });
}

export async function unblockSender(env: Env, userDid: string, sender: string): Promise<void> {
  await env.DB.prepare('DELETE FROM newsletter_blocked_senders WHERE user_did = ? AND sender = ?')
    .bind(userDid, sender.trim().toLowerCase())
    .run();
}

/**
 * Make sure the reader holds a subscription for this sender. Returns false when
 * their plan's mirror ceiling leaves no room for another row — the message is
 * dropped then, exactly as a PDS record over the ceiling is not mirrored.
 *
 * Over the ACTIVE cap the subscription is created parked, like any other
 * overflow: kept, and reactivated from Manage feeds.
 */
async function ensureNewsletterSubscription(
  env: Env,
  userDid: string,
  feedUrl: string,
  title: string,
  siteUrl: string | null
): Promise<boolean> {
  const existing = await env.DB.prepare(
    `SELECT 1 AS ok FROM subscriptions_cache WHERE user_did = ? AND feed_url = ? LIMIT 1`
  )
    .bind(userDid, feedUrl)
    .first<{ ok: number }>();
  if (existing) return true;

  const limits = await getUserTierLimits(env, userDid);
  const counts = await env.DB.prepare(
    `SELECT COUNT(*) AS total, COALESCE(SUM(active = 1), 0) AS active
       FROM subscriptions_cache WHERE user_did = ?`
  )
    .bind(userDid)
    .first<{ total: number; active: number }>();
  if ((counts?.total ?? 0) >= limits.maxMirroredSubscriptions) return false;
  const active = (counts?.active ?? 0) < limits.maxSubscriptions ? 1 : 0;

  // A TID rkey like every other row, so the client's rkey-addressed routes
  // (rename, park, delete) work on it unchanged. The record_uri names a PDS
  // record that never exists — nothing ever pushes this row.
  const recordUri = `at://${userDid}/app.skyreader.feed.subscription/${generateTid()}`;
  await env.DB.prepare(
    `INSERT OR IGNORE INTO subscriptions_cache
       (user_did, record_uri, feed_url, title, site_url, created_at, source_type, source, active)
     VALUES (?, ?, ?, ?, ?, unixepoch(), ?, 'email', ?)`
  )
    .bind(userDid, recordUri, feedUrl, title, siteUrl, NEWSLETTER_SOURCE_TYPE, active)
    .run();
  return true;
}

/** Count this message against the inbox's daily allowance; true if it fits. */
async function takeDailyAllowance(env: Env, userDid: string, nowMs: number): Promise<boolean> {
  const day = Math.floor(nowMs / 86_400_000);
  const row = await env.DB.prepare(
    `UPDATE newsletter_inboxes
        SET day_count = CASE WHEN day_bucket = ?1 THEN day_count + 1 ELSE 1 END,
            day_bucket = ?1,
            last_received_at = ?2
      WHERE user_did = ?3
      RETURNING day_count`
  )
    .bind(day, Math.floor(nowMs / 1000), userDid)
    .first<{ day_count: number }>();
  return (row?.day_count ?? Infinity) <= MAX_NEWSLETTER_EMAILS_PER_DAY;
}

/** The slice of Cloudflare's ForwardableEmailMessage this handler uses. */
export interface InboundEmail {
  readonly to: string;
  readonly raw: ReadableStream<Uint8Array>;
  readonly rawSize: number;
  setReject(reason: string): void;
}

export type InboundOutcome =
  | 'ingested'
  | 'rejected_disabled'
  | 'rejected_unknown_recipient'
  | 'rejected_too_large'
  | 'rejected_not_entitled'
  | 'dropped_over_daily_limit'
  | 'dropped_unparseable'
  | 'dropped_blocked_sender'
  | 'dropped_over_mirror_cap';

/**
 * The Worker's `email()` handler body.
 *
 * Rejections are SMTP-visible bounces, used only where the sender should learn
 * something: the address doesn't exist, or the reader's plan no longer covers
 * it (a platform that sees bounces stops sending, which is what a lapsed plan
 * should lead to). Everything else is accepted and dropped quietly — a bounce
 * for a blocked sender would tell them the address is live.
 *
 * A D1 failure throws, so the sending server gets a temporary failure and
 * retries; the Message-ID guid makes the retry an idempotent re-ingest.
 */
export async function handleInboundEmail(
  message: InboundEmail,
  env: Env,
  nowMs = Date.now()
): Promise<InboundOutcome> {
  const domain = newsletterDomain(env);
  if (!domain) {
    message.setReject('Newsletter delivery is not enabled.');
    return 'rejected_disabled';
  }

  const token = tokenFromRecipient(message.to, domain);
  const inbox = token
    ? await env.DB.prepare(
        'SELECT user_did, inbox_id FROM newsletter_inboxes WHERE address_token = ?'
      )
        .bind(token)
        .first<{ user_did: string; inbox_id: string }>()
    : null;
  if (!inbox) {
    message.setReject('No such mailbox.');
    return 'rejected_unknown_recipient';
  }

  if (message.rawSize > MAX_NEWSLETTER_EMAIL_BYTES) {
    message.setReject('Message too large.');
    return 'rejected_too_large';
  }

  const limits = await getUserTierLimits(env, inbox.user_did);
  if (!limits.newsletterInbox) {
    message.setReject('This mailbox is not active.');
    log.info('newsletter_rejected_not_entitled', { userDid: inbox.user_did });
    return 'rejected_not_entitled';
  }

  if (!(await takeDailyAllowance(env, inbox.user_did, nowMs))) {
    log.warn('newsletter_daily_limit', {
      userDid: inbox.user_did,
      limit: MAX_NEWSLETTER_EMAILS_PER_DAY,
    });
    return 'dropped_over_daily_limit';
  }

  let parsed;
  try {
    parsed = await parseNewsletterEmail(message.raw, nowMs);
  } catch (error) {
    log.warn('newsletter_parse_failed', { userDid: inbox.user_did, ...serializeError(error) });
    return 'dropped_unparseable';
  }
  if (!parsed) return 'dropped_unparseable';

  const blocked = await env.DB.prepare(
    'SELECT 1 AS ok FROM newsletter_blocked_senders WHERE user_did = ? AND sender = ?'
  )
    .bind(inbox.user_did, parsed.sender)
    .first<{ ok: number }>();
  if (blocked) return 'dropped_blocked_sender';

  const feedUrl = newsletterFeedUrl(inbox.inbox_id, parsed.sender);
  const title = parsed.senderName ?? parsed.sender;
  if (!(await ensureNewsletterSubscription(env, inbox.user_did, feedUrl, title, parsed.siteUrl))) {
    log.warn('newsletter_over_mirror_cap', { userDid: inbox.user_did });
    return 'dropped_over_mirror_cap';
  }

  const publishedMs = new Date(parsed.item.publishedAt).getTime();
  await ingestBatch(
    env,
    [{ feedUrl, title, siteUrl: parsed.siteUrl, description: null, imageUrl: null }],
    [
      {
        feedUrl,
        guid: parsed.item.guid,
        item: parsed.item,
        publishedAt: Number.isNaN(publishedMs) ? null : publishedMs,
        firstSeenAt: nowMs,
        contentHash: await computeContentHash(parsed.item),
      },
    ]
  );
  log.info('newsletter_ingested', { userDid: inbox.user_did });
  return 'ingested';
}
