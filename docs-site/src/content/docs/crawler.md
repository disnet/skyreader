---
title: Skyreader's feed fetcher
description: How Skyreader fetches the feeds its readers subscribe to, and how a site owner can limit or block it.
---

Skyreader fetches RSS and Atom feeds that its readers have subscribed to. It only fetches feeds
someone asked for. It does not crawl or index sites.

## How to recognise it

- **User-Agent:** `Skyreader/1.0 (+https://skyreader.app)`
- **Signed requests:** every fetch carries a [Web Bot Auth](https://developers.cloudflare.com/bots/reference/bot-verification/web-bot-auth/)
  signature. The key is published at
  `https://api.skyreader.app/.well-known/http-message-signatures-directory`. Cloudflare lists
  Skyreader as a verified feed fetcher.

## robots.txt

Skyreader reads your `robots.txt` before fetching a feed and caches it for up to a day.

- **To block or limit Skyreader,** add a group that names it. Skyreader honours `Disallow` and
  `Allow` rules in that group:

  ```
  User-agent: Skyreader
  Disallow: /
  ```

- **Rules for all crawlers** (`User-agent: *`) are treated as written for search engines. Like
  Google's feed fetcher and other feed readers, Skyreader still fetches a feed a reader subscribed
  to when only the `*` group disallows it.
- **`Crawl-delay`** is honoured from either group, up to 60 seconds.

Readers whose feed is blocked see that the site doesn't allow Skyreader's feed fetcher.
