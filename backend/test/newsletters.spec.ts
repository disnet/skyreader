import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import worker from '../src/index';
import {
  MAX_NEWSLETTER_EMAILS_PER_DAY,
  NEWSLETTER_SOURCE_TYPE,
  handleInboundEmail,
  issueNewsletterInbox,
  newsletterFeedUrl,
  tokenFromRecipient,
  type InboundEmail,
} from '../src/services/newsletters';
import {
  cleanEmailHtml,
  parseNewsletterEmail,
  wrapEmailBody,
} from '../src/services/newsletter-email';
import { handleCrawlSet } from '../src/routes/ingest';
import { upsertSubscriptionFromFirehose } from '../src/services/firehose-subscription';

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

const DOMAIN = 'inbox.test';
const READER = 'did:plc:newsletterreader';
const OTHER = 'did:plc:newsletterother';
const SESSIONS: Record<string, string> = {
  [READER]: 'test-session-newsletter-reader',
  [OTHER]: 'test-session-newsletter-other',
};
const COLLECTION = 'app.skyreader.feed.subscription';
const PROXY_SECRET = 'newsletter-proxy-secret';

async function seedUser(did: string, tier: 'free' | 'supporter') {
  await env.DB.prepare(
    `INSERT INTO users (did, handle, pds_url, tier, created_at, last_active_at)
     VALUES (?, ?, 'https://test.pds.example', ?, unixepoch(), unixepoch())`
  )
    .bind(did, `${did}.test`, tier)
    .run();
  await env.DB.prepare(
    `INSERT INTO sessions (session_id, did, handle, pds_url, access_token, refresh_token, dpop_private_key, expires_at)
     VALUES (?, ?, ?, 'https://test.pds.example', 'at', 'rt', '{}', ?)`
  )
    .bind(SESSIONS[did], did, `${did}.test`, Date.now() + 3_600_000)
    .run();
}

function authed(did: string, path: string, opts?: { method?: string; body?: unknown }) {
  return new IncomingRequest(`http://localhost${path}`, {
    method: opts?.method ?? 'GET',
    headers: {
      Cookie: `session_id=${SESSIONS[did]}`,
      'Content-Type': 'application/json',
      Origin: env.FRONTEND_URL,
    },
    body: opts?.body ? JSON.stringify(opts.body) : undefined,
  });
}

async function call(request: Request) {
  const ctx = createExecutionContext();
  const res = await worker.fetch(request, env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

function rawEmail(opts: {
  from?: string;
  subject?: string;
  messageId?: string;
  date?: string;
  html?: string;
  text?: string;
  headers?: string[];
}): string {
  const lines = [
    `From: ${opts.from ?? 'Money Stuff <moneystuff@news.example.com>'}`,
    `To: reader@${DOMAIN}`,
    `Subject: ${opts.subject ?? 'The big one'}`,
    `Message-ID: <${opts.messageId ?? 'issue-1@news.example.com'}>`,
    `Date: ${opts.date ?? 'Tue, 22 Sep 2026 12:00:00 +0000'}`,
    'MIME-Version: 1.0',
    ...(opts.headers ?? []),
  ];
  if (opts.html) {
    lines.push('Content-Type: text/html; charset=utf-8', '', opts.html);
  } else {
    lines.push('Content-Type: text/plain; charset=utf-8', '', opts.text ?? 'Hello readers.');
  }
  return lines.join('\r\n');
}

function inbound(to: string, raw: string) {
  const bytes = new TextEncoder().encode(raw);
  const message: InboundEmail & { rejected: string | null } = {
    to,
    raw: new Response(bytes).body!,
    rawSize: bytes.length,
    rejected: null,
    setReject(reason: string) {
      this.rejected = reason;
    },
  };
  return message;
}

async function addressFor(did: string): Promise<string> {
  const inbox = await issueNewsletterInbox(env, did, false);
  return `${inbox.token}@${DOMAIN}`;
}

async function newsletterSubs(did: string) {
  const rows = await env.DB.prepare(
    `SELECT record_uri, feed_url, title, source_type, active FROM subscriptions_cache WHERE user_did = ?`
  )
    .bind(did)
    .all<{
      record_uri: string;
      feed_url: string;
      title: string;
      source_type: string;
      active: number;
    }>();
  return rows.results;
}

describe('email newsletters', () => {
  let originalFetch: typeof fetch;

  beforeEach(async () => {
    originalFetch = globalThis.fetch;
    // Nothing here should reach the network; a PDS push would land in this stub.
    globalThis.fetch = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    for (const table of [
      'feed_items',
      'feeds',
      'subscriptions_cache',
      'newsletter_inboxes',
      'newsletter_blocked_senders',
      'user_settings',
      'sessions',
      'users',
    ]) {
      await env.DB.prepare(`DELETE FROM ${table}`).run();
    }
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  describe('parsing', () => {
    it('keeps the body, drops head/style/preheader/pixels, finds the web copy', async () => {
      const html = `<!doctype html><html><head><style>p{color:red}</style><title>x</title></head>
        <body><div style="display:none;max-height:0">Preview text here</div>
        <p>First <b>paragraph</b>.</p>
        <a href="https://news.example.com/p/the-big-one?utm=1&amp;x=2">View in browser</a>
        <img src="https://t.example/open.gif" width="1" height="1">
        <img src="https://news.example.com/chart.png" width="600"></body></html>`;
      const parsed = await parseNewsletterEmail(rawEmail({ html }), Date.now());
      expect(parsed).not.toBeNull();
      expect(parsed!.sender).toBe('moneystuff@news.example.com');
      expect(parsed!.senderName).toBe('Money Stuff');
      expect(parsed!.item.guid).toBe('issue-1@news.example.com');
      expect(parsed!.item.title).toBe('The big one');
      expect(parsed!.item.url).toBe('https://news.example.com/p/the-big-one?utm=1&x=2');
      expect(parsed!.item.publishedAt).toBe('2026-09-22T12:00:00.000Z');
      const content = parsed!.item.content!;
      expect(content).toContain('<p>First <b>paragraph</b>.</p>');
      expect(content).toContain('chart.png');
      expect(content).not.toContain('open.gif');
      expect(content).not.toContain('Preview text');
      expect(content).not.toContain('color:red');
      expect(content).not.toContain('<body');
    });

    it('wraps the body in the email-body scope the reader resets type sizes on', async () => {
      const parsed = await parseNewsletterEmail(
        rawEmail({ html: '<body><h1>Fine print</h1></body>' }),
        Date.now()
      );
      expect(parsed!.item.content).toBe('<div class="sr-email-body"><h1>Fine print</h1></div>');
      // Idempotent, however the wrapper was serialized.
      expect(wrapEmailBody(parsed!.item.content!)).toBe(parsed!.item.content);
      expect(wrapEmailBody(" \n<div class='sr-email-body x'><p>a</p></div>")).toBe(
        " \n<div class='sr-email-body x'><p>a</p></div>"
      );
      // A template's own hyphenated class is not the wrapper.
      expect(wrapEmailBody('<div class="sr-email-body-wrapper"><p>a</p></div>')).toBe(
        '<div class="sr-email-body"><div class="sr-email-body-wrapper"><p>a</p></div></div>'
      );
    });

    it('turns a plain-text newsletter into paragraphs with links', async () => {
      const parsed = await parseNewsletterEmail(
        rawEmail({ text: 'Hello <friends>.\r\n\r\nRead https://example.com/post today.' }),
        Date.now()
      );
      expect(parsed!.item.content).toBe(
        '<div class="sr-email-body"><p>Hello &lt;friends&gt;.</p>\n<p>Read <a href="https://example.com/post">https://example.com/post</a> today.</p></div>'
      );
      expect(parsed!.item.summary).toBe('Hello &lt;friends&gt;. Read today.');
      expect(parsed!.siteUrl).toBe('https://news.example.com');
    });

    it('prefers List-URL for the site and clamps a future date', async () => {
      const now = Date.parse('2026-09-22T12:00:00Z');
      const parsed = await parseNewsletterEmail(
        rawEmail({
          date: 'Fri, 01 Jan 2100 00:00:00 +0000',
          headers: ['List-URL: <https://moneystuff.example.org/archive>'],
        }),
        now
      );
      expect(parsed!.siteUrl).toBe('https://moneystuff.example.org');
      expect(parsed!.item.publishedAt).toBe(new Date(now).toISOString());
    });

    it('cleans nested hidden wrappers without eating the rest', () => {
      expect(cleanEmailHtml('<span style="display: none">pre</span><p>kept</p><!-- c -->')).toBe(
        '<p>kept</p>'
      );
    });

    it('removes a hidden block with nested markup or quoted styles whole', () => {
      expect(
        cleanEmailHtml(
          '<div style="display:none"><div>pre</div><div>view</div></div><div><p>kept</p></div>'
        )
      ).toBe('<div><p>kept</p></div>');
      expect(
        cleanEmailHtml(
          `<div style="font-family:'Arial',sans-serif;display:none;max-height:0">pre</div><p>kept</p>`
        )
      ).toBe('<p>kept</p>');
      expect(
        cleanEmailHtml(
          `<td style='display: none; font-family: "Helvetica"'><span>pre</span></td><p>kept</p>`
        )
      ).toBe('<p>kept</p>');
      // An unclosed hidden element is left alone rather than eating the rest.
      expect(cleanEmailHtml('<div style="display:none">pre<p>kept</p>')).toContain('kept');
    });

    it('files a Gmail inline forward under the original sender', async () => {
      const parsed = await parseNewsletterEmail(
        rawEmail({
          from: 'Reader <reader@gmail.example>',
          subject: 'Fwd: The big one',
          text: [
            'Thought I would save this.',
            '',
            '---------- Forwarded message ---------',
            'From: Money Stuff <moneystuff@news.example.com>',
            'Date: Tue, Sep 22, 2026 at 8:00 AM',
            'Subject: The big one',
            'To: <reader@gmail.example>',
            '',
            '',
            'Hello readers.',
          ].join('\r\n'),
        }),
        Date.now()
      );
      expect(parsed!.sender).toBe('moneystuff@news.example.com');
      expect(parsed!.senderName).toBe('Money Stuff');
      expect(parsed!.siteUrl).toBe('https://news.example.com');
      expect(parsed!.item.title).toBe('The big one');
      // Dated by the forward (the outer Date), not the quoted 8:00 AM original.
      expect(parsed!.item.publishedAt).toBe('2026-09-22T12:00:00.000Z');
      expect(parsed!.item.content).toBe('<div class="sr-email-body"><p>Hello readers.</p></div>');
    });

    it('files an Outlook or Apple Mail forward under the original sender', async () => {
      const outlook = await parseNewsletterEmail(
        rawEmail({
          from: 'reader@outlook.example',
          subject: 'FW: Weekly',
          text: [
            '________________________________',
            'From: Weekly Digest [mailto:digest@weekly.example.org]',
            'Sent: Tuesday, September 22, 2026 12:00 PM',
            'To: Reader',
            'Subject: Weekly',
            '',
            'Body.',
          ].join('\r\n'),
        }),
        Date.now()
      );
      expect(outlook!.sender).toBe('digest@weekly.example.org');
      expect(outlook!.senderName).toBe('Weekly Digest');

      const apple = await parseNewsletterEmail(
        rawEmail({
          from: 'reader@icloud.example',
          subject: 'Fwd: Weekly',
          html: `<div>Begin forwarded message:</div><br><div><b>From: </b>Weekly Digest &lt;digest@weekly.example.org&gt;</div><div><b>Subject: </b>Weekly</div><br><p>Body.</p>`,
        }),
        Date.now()
      );
      expect(apple!.sender).toBe('digest@weekly.example.org');
      expect(apple!.item.title).toBe('Weekly');
    });

    it('drops an Apple Mail forward’s quote and header block from the body', async () => {
      const row = (label: string, value: string) =>
        `<div style="margin: 0px;"><span style="font-family: -webkit-system-font;"><b>${label}: </b></span>` +
        `<span style="font-family: -webkit-system-font;">${value}<br></span></div>`;
      const parsed = await parseNewsletterEmail(
        rawEmail({
          from: 'reader@icloud.example',
          subject: 'Fwd: Weekly',
          html:
            '<html><body><br id="lineBreakAtBeginningOfMessage"><div><br><blockquote type="cite">' +
            '<div>Begin forwarded message:</div><br class="Apple-interchange-newline">' +
            row('From', 'Weekly Digest &lt;digest@weekly.example.org&gt;') +
            row('Subject', '<b>Weekly</b>') +
            row('Date', 'September 25, 2026 at 11:48:26 AM PDT') +
            row('To', 'reader@icloud.example') +
            row('Reply-To', 'no-reply@weekly.example.org') +
            '<br><div><h1>Weekly</h1><p>Body: the issue.</p></div></blockquote></div></body></html>',
        }),
        Date.now()
      );
      const content = parsed!.item.content!;
      expect(content.startsWith('<div class="sr-email-body"><br><div><h1>Weekly</h1>')).toBe(true);
      expect(content).toContain('<p>Body: the issue.</p>');
      expect(content).not.toMatch(/forwarded message|<blockquote|From: |Reply-To/i);
    });

    it('drops a Gmail HTML forward’s note and attribution from the body', async () => {
      const parsed = await parseNewsletterEmail(
        rawEmail({
          from: 'Reader <reader@gmail.example>',
          subject: 'Fwd: The big one',
          html:
            '<div dir="ltr">Saving this.<br><br><div class="gmail_quote"><div dir="ltr" class="gmail_attr">' +
            '---------- Forwarded message ---------<br>From: <strong>Money Stuff</strong> ' +
            '<span dir="auto">&lt;moneystuff@news.example.com&gt;</span><br>Date: Tue, Sep 22, 2026 at 8:00 AM<br>' +
            'Subject: The big one<br>To: &lt;reader@gmail.example&gt;<br></div><br><br><p>Hello readers.</p></div></div>',
        }),
        Date.now()
      );
      expect(parsed!.sender).toBe('moneystuff@news.example.com');
      const content = parsed!.item.content!;
      expect(content).toContain('<p>Hello readers.</p>');
      expect(content).not.toMatch(/Saving this|Forwarded message|Subject:/);
    });

    it('files a forward-as-attachment under the attached message’s sender', async () => {
      const inner = rawEmail({ html: '<p>Inside.</p>', messageId: 'orig@news.example.com' });
      const raw = [
        'From: Reader <reader@gmail.example>',
        `To: reader@${DOMAIN}`,
        'Subject: Fwd: The big one',
        'Date: Mon, 28 Sep 2026 09:30:00 +0000',
        'MIME-Version: 1.0',
        'Content-Type: multipart/mixed; boundary=BOUND',
        '',
        '--BOUND',
        'Content-Type: text/plain',
        '',
        'See attached.',
        '--BOUND',
        'Content-Type: message/rfc822',
        'Content-Disposition: attachment; filename="issue.eml"',
        '',
        inner,
        '--BOUND--',
        '',
      ].join('\r\n');
      const parsed = await parseNewsletterEmail(raw, Date.now());
      expect(parsed!.sender).toBe('moneystuff@news.example.com');
      expect(parsed!.item.guid).toBe('orig@news.example.com');
      expect(parsed!.item.content).toBe('<div class="sr-email-body"><p>Inside.</p></div>');
      expect(parsed!.item.publishedAt).toBe('2026-09-28T09:30:00.000Z');
    });

    it('keys an unrecognizable forward on its own From', async () => {
      const parsed = await parseNewsletterEmail(
        rawEmail({ from: 'reader@gmail.example', subject: 'Fwd: hi', text: 'no headers here' }),
        Date.now()
      );
      expect(parsed!.sender).toBe('reader@gmail.example');
    });

    it('reads the token out of a plus-addressed recipient', () => {
      expect(tokenFromRecipient('AbC123+substack@Inbox.Test', DOMAIN)).toBe('abc123');
      expect(tokenFromRecipient('abc123@elsewhere.test', DOMAIN)).toBeNull();
    });
  });

  describe('inbound mail', () => {
    it('lands a supporter’s newsletter as a private, local subscription with its item', async () => {
      await seedUser(READER, 'supporter');
      const message = inbound(await addressFor(READER), rawEmail({}));
      expect(await handleInboundEmail(message, env)).toBe('ingested');
      expect(message.rejected).toBeNull();

      const subs = await newsletterSubs(READER);
      expect(subs).toHaveLength(1);
      expect(subs[0].source_type).toBe(NEWSLETTER_SOURCE_TYPE);
      expect(subs[0].title).toBe('Money Stuff');
      expect(subs[0].active).toBe(1);
      expect(subs[0].feed_url).toMatch(/^newsletter:[0-9a-f]{16}\/moneystuff@news\.example\.com$/);
      expect(subs[0].record_uri).toMatch(new RegExp(`^at://${READER}/${COLLECTION}/[a-z2-7]{13}$`));

      const item = await env.DB.prepare('SELECT guid, item_json FROM feed_items WHERE feed_url = ?')
        .bind(subs[0].feed_url)
        .first<{ guid: string; item_json: string }>();
      expect(item?.guid).toBe('issue-1@news.example.com');
      expect(JSON.parse(item!.item_json).title).toBe('The big one');

      // The next issue joins the same subscription; a re-delivery is a no-op.
      await handleInboundEmail(
        inbound(await addressFor(READER), rawEmail({ messageId: 'issue-2@news.example.com' })),
        env
      );
      await handleInboundEmail(inbound(await addressFor(READER), rawEmail({})), env);
      expect(await newsletterSubs(READER)).toHaveLength(1);
      const count = await env.DB.prepare('SELECT COUNT(*) AS n FROM feed_items').first<{
        n: number;
      }>();
      expect(count?.n).toBe(2);
      // Local-only: nothing went to a PDS.
      expect(globalThis.fetch).not.toHaveBeenCalled();
    });

    it('bounces mail for an unknown address', async () => {
      const message = inbound(`nobody@${DOMAIN}`, rawEmail({}));
      expect(await handleInboundEmail(message, env)).toBe('rejected_unknown_recipient');
      expect(message.rejected).toBeTruthy();
    });

    it('bounces mail once the reader’s plan no longer covers it', async () => {
      await seedUser(READER, 'supporter');
      const address = await addressFor(READER);
      await env.DB.prepare(`UPDATE users SET tier = 'free' WHERE did = ?`).bind(READER).run();
      const message = inbound(address, rawEmail({}));
      expect(await handleInboundEmail(message, env)).toBe('rejected_not_entitled');
      expect(message.rejected).toBeTruthy();
      expect(await newsletterSubs(READER)).toHaveLength(0);
    });

    it('stops accepting mail at the old address after a rotation', async () => {
      await seedUser(READER, 'supporter');
      const before = await addressFor(READER);
      const after = await issueNewsletterInbox(env, READER, true);
      expect(`${after.token}@${DOMAIN}`).not.toBe(before);
      expect(await handleInboundEmail(inbound(before, rawEmail({})), env)).toBe(
        'rejected_unknown_recipient'
      );
      expect(await handleInboundEmail(inbound(`${after.token}@${DOMAIN}`, rawEmail({})), env)).toBe(
        'ingested'
      );
    });

    it('caps what one inbox can ingest in a day', async () => {
      await seedUser(READER, 'supporter');
      const address = await addressFor(READER);
      await env.DB.prepare(
        `UPDATE newsletter_inboxes SET day_bucket = ?, day_count = ? WHERE user_did = ?`
      )
        .bind(Math.floor(Date.now() / 86_400_000), MAX_NEWSLETTER_EMAILS_PER_DAY, READER)
        .run();
      expect(await handleInboundEmail(inbound(address, rawEmail({})), env)).toBe(
        'dropped_over_daily_limit'
      );
    });
  });

  describe('API', () => {
    it('never marks a renamed newsletter as owed to the PDS', async () => {
      await seedUser(READER, 'supporter');
      await env.DB.prepare(
        `INSERT INTO user_settings (user_did, pds_sync_enabled, created_at, updated_at)
         VALUES (?, 1, unixepoch(), unixepoch())`
      )
        .bind(READER)
        .run();
      await handleInboundEmail(inbound(await addressFor(READER), rawEmail({})), env);
      const [sub] = await newsletterSubs(READER);
      const rkey = sub.record_uri.split('/').pop()!;

      const single = await call(
        authed(READER, `/api/subscriptions/${rkey}`, {
          method: 'PATCH',
          body: { customTitle: 'Matt Levine' },
        })
      );
      expect(single.status).toBe(200);
      const bulk = await call(
        authed(READER, '/api/subscriptions/bulk-update', {
          method: 'POST',
          body: { rkeys: [rkey], updates: { category: 'Finance' } },
        })
      );
      expect(bulk.status).toBe(200);

      const row = await env.DB.prepare(
        'SELECT custom_title, category, pds_dirty FROM subscriptions_cache WHERE record_uri = ?'
      )
        .bind(sub.record_uri)
        .first<{ custom_title: string; category: string; pds_dirty: number }>();
      expect(row).toEqual({ custom_title: 'Matt Levine', category: 'Finance', pds_dirty: 0 });
      expect(globalThis.fetch).not.toHaveBeenCalled();
    });

    it('imports the real feeds of an OPML that carries a newsletter row', async () => {
      await seedUser(READER, 'supporter');
      const res = await call(
        authed(READER, '/api/subscriptions/bulk', {
          method: 'POST',
          body: {
            subscriptions: [
              { rkey: 'aaaaaaaaaaaa1', feedUrl: 'https://example.com/feed.xml', title: 'A' },
              { rkey: 'bbbbbbbbbbbb2', feedUrl: 'newsletter:0011223344556677/x@y.test' },
            ],
          },
        })
      );
      expect(res.status).toBe(200);
      const rows = await newsletterSubs(READER);
      expect(rows.map((r) => r.feed_url)).toEqual(['https://example.com/feed.xml']);
    });

    it('reports the feature and refuses an address to a free reader', async () => {
      await seedUser(READER, 'free');
      const get = await call(authed(READER, '/api/newsletters'));
      expect(await get.json()).toMatchObject({ enabled: true, entitled: false, address: null });

      const post = await call(authed(READER, '/api/newsletters/address', { method: 'POST' }));
      expect(post.status).toBe(403);
      expect(await post.json()).toMatchObject({ code: 'upgrade_required' });
    });

    it('issues a stable address to a supporter and rotates it on request', async () => {
      await seedUser(READER, 'supporter');
      const first = (await (
        await call(authed(READER, '/api/newsletters/address', { method: 'POST' }))
      ).json()) as { address: string };
      expect(first.address).toMatch(new RegExp(`^[a-z2-9]{12}@${DOMAIN.replace('.', '\\.')}$`));

      const again = (await (
        await call(authed(READER, '/api/newsletters/address', { method: 'POST' }))
      ).json()) as { address: string };
      expect(again.address).toBe(first.address);

      const rotated = (await (
        await call(
          authed(READER, '/api/newsletters/address', { method: 'POST', body: { rotate: true } })
        )
      ).json()) as { address: string };
      expect(rotated.address).not.toBe(first.address);

      const get = (await (await call(authed(READER, '/api/newsletters'))).json()) as {
        entitled: boolean;
        address: string;
      };
      expect(get).toMatchObject({ entitled: true, address: rotated.address });
    });

    it('blocks the sender when the subscription is deleted, and unblocks on request', async () => {
      await seedUser(READER, 'supporter');
      const address = await addressFor(READER);
      await handleInboundEmail(inbound(address, rawEmail({})), env);
      const [sub] = await newsletterSubs(READER);
      const rkey = sub.record_uri.split('/').pop();

      const del = await call(authed(READER, `/api/subscriptions/${rkey}`, { method: 'DELETE' }));
      expect(del.status).toBe(200);
      expect(await newsletterSubs(READER)).toHaveLength(0);

      // The next issue doesn't resurrect it.
      expect(
        await handleInboundEmail(
          inbound(address, rawEmail({ messageId: 'issue-2@news.example.com' })),
          env
        )
      ).toBe('dropped_blocked_sender');
      expect(await newsletterSubs(READER)).toHaveLength(0);

      const get = (await (await call(authed(READER, '/api/newsletters'))).json()) as {
        blockedSenders: Array<{ sender: string }>;
      };
      expect(get.blockedSenders.map((b) => b.sender)).toEqual(['moneystuff@news.example.com']);

      await call(
        authed(READER, '/api/newsletters/blocked?sender=moneystuff%40news.example.com', {
          method: 'DELETE',
        })
      );
      expect(
        await handleInboundEmail(
          inbound(address, rawEmail({ messageId: 'issue-3@news.example.com' })),
          env
        )
      ).toBe('ingested');
    });
  });

  describe('privacy', () => {
    async function seedNewsletter(): Promise<string> {
      await seedUser(READER, 'supporter');
      await seedUser(OTHER, 'supporter');
      await handleInboundEmail(inbound(await addressFor(READER), rawEmail({})), env);
      const [sub] = await newsletterSubs(READER);
      return sub.feed_url;
    }

    it('serves the per-feed read to the inbox owner only', async () => {
      const feedUrl = await seedNewsletter();
      const path = `/api/v2/feeds/fetch?url=${encodeURIComponent(feedUrl)}`;

      const mine = await call(authed(READER, path));
      expect(mine.status).toBe(200);
      const body = (await mine.json()) as { title: string; items: Array<{ guid: string }> };
      expect(body.title).toBe('Money Stuff');
      expect(body.items.map((i) => i.guid)).toEqual(['issue-1@news.example.com']);

      const theirs = await call(authed(OTHER, path));
      expect(theirs.status).toBe(404);
    });

    it('refuses a newsletter subscription created through the API', async () => {
      const feedUrl = await seedNewsletter();
      const res = await call(
        authed(OTHER, '/api/subscriptions', {
          method: 'POST',
          body: { rkey: 'aaaaaaaaaaaa1', feedUrl, title: 'Not mine' },
        })
      );
      expect(res.status).toBe(400);
      expect(await newsletterSubs(OTHER)).toHaveLength(0);
    });

    it('ignores a PDS record that names a newsletter feed', async () => {
      const feedUrl = await seedNewsletter();
      await upsertSubscriptionFromFirehose(env.DB, OTHER, 'aaaaaaaaaaaa1', {
        feedUrl,
        createdAt: new Date().toISOString(),
      });
      expect(await newsletterSubs(OTHER)).toHaveLength(0);
    });

    it('keeps newsletters out of the crawl set', async () => {
      const feedUrl = await seedNewsletter();
      const saved = env.FEED_PROXY_SECRET;
      env.FEED_PROXY_SECRET = PROXY_SECRET;
      try {
        const res = await handleCrawlSet(
          new Request('https://api.example/api/internal/crawl-set', {
            headers: { 'X-Proxy-Secret': PROXY_SECRET },
          }),
          env
        );
        const body = (await res.json()) as { feeds: Array<{ feedUrl: string }> };
        expect(body.feeds.map((f) => f.feedUrl)).not.toContain(feedUrl);
      } finally {
        env.FEED_PROXY_SECRET = saved;
      }
    });

    it('names feeds by inbox id, not by the secret address', async () => {
      await seedUser(READER, 'supporter');
      const inbox = await issueNewsletterInbox(env, READER, false);
      const feedUrl = newsletterFeedUrl(inbox.inboxId, 'x@example.com');
      expect(feedUrl).not.toContain(inbox.token);
    });
  });
});
