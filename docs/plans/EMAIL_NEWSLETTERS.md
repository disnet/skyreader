# Email newsletters

Supporters get one private address, `<token>@<NEWSLETTER_EMAIL_DOMAIN>`. Mail sent to it lands in
their reader: one subscription per sender, one article per issue.

## How it works

```
sender ──SMTP──▶ Cloudflare Email Routing (catch-all on the domain)
                    │
                    ▼
        Worker email() handler (backend/src/index.ts)
                    │  handleInboundEmail (services/newsletters.ts)
                    │   1. recipient token → newsletter_inboxes row → user
                    │   2. plan check: TierLimits.newsletterInbox
                    │   3. daily allowance (200/inbox/UTC day)
                    │   4. parse MIME (postal-mime; services/newsletter-email.ts)
                    │   5. blocked sender? drop
                    │   6. ensure subscriptions_cache row (source_type 'email.newsletter')
                    │   7. ingestBatch → feed_items (+ R2 for over-cap bodies)
                    ▼
        GET /api/v2/timeline serves it like any feed
```

- **Feed identity.** `feed_url` is `newsletter:<inbox_id>/<sender address>`. `inbox_id` is random
  and never changes; the address token is separate, so rotating the address (Settings → Get a new
  address) kills the old one without orphaning anything already received.
- **Item identity.** `guid` is the Message-ID, so a redelivery is an idempotent re-ingest. The
  body is the email's HTML with head/style/script, the hidden preheader and 1×1 tracking pixels
  removed; the reader's sanitizer is still the safety boundary. `url` is the newsletter's own
  "View in browser" link when one can be found, else empty.
- **Bounces vs drops.** Unknown address, oversized message (>5 MB) and a lapsed plan are SMTP
  rejections, so a sending platform learns to stop. A blocked sender, the daily cap and an
  unparseable message are accepted and dropped quietly. A D1 failure throws, so the sender gets a
  temporary failure and retries.

## Private and local-only

A newsletter subscription differs from every other kind, and one predicate —
`isNewsletterSubscription(feedUrl, sourceType)` — enforces it everywhere:

| Path                                              | Rule                                                     |
| ------------------------------------------------- | -------------------------------------------------------- |
| `GET /api/internal/crawl-set`                     | never crawled (`newsletter:` isn't fetchable)            |
| PDS push (single, bulk, sync repair)              | never written to the PDS: it would publish what you read |
| PDS pull, firehose mirror                         | a record naming a newsletter feed is ignored             |
| `POST /api/subscriptions`, `/bulk`                | refused: only inbound mail creates one                   |
| `DELETE /api/subscriptions/:rkey`, `/bulk-delete` | no PDS delete; the sender is blocked                     |
| `/api/v2/feeds/fetch`, `/api/v2/items/body`       | owner only (checked against `newsletter_inboxes`)        |
| `/api/guest/items/body`                           | never                                                    |

The insertion guards matter because the timeline joins on `subscriptions_cache.feed_url`: a row
naming someone else's inbox would serve their mail. The per-feed reads check the inbox's owner
directly, so they hold however a row came to exist.

On the client (`frontend/src/lib/utils/newsletters.ts`), newsletters count as archive feeds —
timeline, unread counts, "Show older", mark-all-read, channels — and are skipped only on the
legacy `/api/v2/feeds/batch` path, which asks the crawler. `/api/v2/feeds/fetch` never pulls a
newsletter through the proxy, so the per-feed backfill and "retry" just read D1.

## Tier

`TierLimits.newsletterInbox` (free `false`, supporter `true`) gates issuing an address and every
inbound message. When a plan lapses the address keeps its row but mail is refused; received
newsletters stay readable. New newsletter subscriptions respect the plan's active/mirror caps like
any other (parked over the active cap, dropped over the mirror cap).

## Enabling

Off until `NEWSLETTER_EMAIL_DOMAIN` is set (empty in `wrangler.toml` for both environments). With
it empty, Settings says delivery isn't available and the handler rejects everything.

1. Pick a domain per environment, e.g. `inbox.skyreader.app` (prod) and
   `inbox-staging.skyreader.app` (staging). Separate domains keep the two isolated.
2. Cloudflare dashboard → the zone → **Email → Email Routing**: enable it for the subdomain (it adds
   the MX/TXT records), then **Routing rules → Catch-all → Send to a Worker** →
   `skyreader-api` (prod) / `skyreader-api-staging` (staging).
3. Set the var (`[vars]` for prod, the `[env.staging]` inline table for staging) and deploy.
4. Verify: as a Supporter, Settings → Newsletters → Create my address; send a message to it from any
   mailbox; it appears under Manage Sources → Newsletters within seconds. Logs: `newsletter_email`
   carries the outcome of every message.

The Supporter page and docs already list the perk, so enable production routing before the release
that carries this ships.
