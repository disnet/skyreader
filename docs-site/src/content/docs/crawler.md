---
title: Skyreader's feed fetcher
description: How Skyreader fetches the feeds its readers subscribe to, and how a site owner can limit or block it.
---

Skyreader refreshes the RSS and Atom feeds its readers subscribe to. It doesn't crawl or index
sites.

## How to recognize it

- **User-Agent:** `Skyreader/1.0 (+https://skyreader.app)`
- **Signed requests:** feed fetches carry a
  [Web Bot Auth](https://developers.cloudflare.com/bots/reference/bot-verification/web-bot-auth/)
  signature. The key is published at
  `https://api.skyreader.app/.well-known/http-message-signatures-directory`. Cloudflare lists
  Skyreader as a verified feed fetcher.

## robots.txt

Skyreader reads your `robots.txt` before refreshing a feed and caches it for up to a day.

- **To block or limit feed refreshes,** add a group with the product token `Skyreader`. Skyreader
  follows the `Disallow` and `Allow` rules in that group:

  ```
  User-agent: Skyreader
  Disallow: /
  ```

- **Rules for all crawlers** (`User-agent: *`) are treated as written for search engines. Like
  Google's feed fetcher and other feed readers, Skyreader still refreshes a feed a reader subscribed
  to when only the `*` group disallows it.
- **`Crawl-delay`** is followed from the `Skyreader` group, or from `*` when that group sets none,
  up to 60 seconds.

Two requests happen once, when a reader asks, and don't check `robots.txt`: fetching a page a reader
saves, and looking up a site's feeds when a reader adds it.

Readers whose feed is blocked see that the site doesn't allow Skyreader's feed fetcher.
