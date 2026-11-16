---
title: AI apps
description: Connect Claude, ChatGPT or another AI app to Skyreader, so it can search and read what you've saved and highlighted, and post to feeds of your own.
---

You can let an AI app work with your reading. Ask Claude what you've saved about a topic, have it pull together your highlights on a question, or summarize an article you saved last month. The app reads your Skyreader library when you ask; it can't change anything in it. If you want, you can also let it post to feeds of your own, so a weekly summary it writes arrives with everything else you read.

This is part of the [Supporter plan](/supporter/).

## Connecting an app

Skyreader connects through MCP (Model Context Protocol), the standard most AI apps use for outside tools. Apps call these **connectors**, **integrations** or **MCP servers**. The address is:

```
https://api.skyreader.app/mcp
```

It's also in **Settings → AI apps**, with a copy button.

1. In your AI app, add a custom connector (or MCP server) and paste the address. In Claude, that's **Settings → Connectors → Add custom connector**.
2. The app opens a Skyreader page. Sign in if you're asked to, the same way you sign in to Skyreader.
3. Skyreader shows which app is asking and where its access will go. To let it post to your own feeds too, tick **Also let it post to your own feeds** (see [below](#posting-to-your-own-feeds)). Choose **Allow**.

You don't make or paste a password: the app gets its own access, which only works through this connection.

In Claude Code, add it from a terminal and sign in when it prompts you:

```
claude mcp add --transport http skyreader https://api.skyreader.app/mcp
```

## What the app can do

- **Search** what you've read, saved and highlighted, the same search as in Skyreader. Search ranks the best 1,000 matches; for anything broader, the app lists instead.
- **List your saves**, newest first, or the ones in a Shelf collection, with how many there are. It can narrow to a date range, such as what you saved in March, and page through your whole library, however big.
- **Read a saved article's text**, all of it. A long article or a book comes in parts of about 30,000 characters, which the app reads one after another.
- **List your highlights and notes**, page by page, for one article, or only what changed since a date.
- **See your Shelf collections**, how many saves each holds, and how many you've saved in all.
- **Post to your own feeds**, only if you ticked the box when you connected it. See below.

When Skyreader adds to this list, some apps keep using the old one until you disconnect and reconnect Skyreader in the app.

It can't save, delete, mark read, change your subscriptions or read your feeds. It sees only your own library, not other people's.

## Posting to your own feeds

An AI app you've allowed to post can write into Skyreader, not just read from it. Ask it for something like "every Monday, summarize what I saved and highlighted last week and post it to my Weekly summary feed", and the summary shows up in your feeds as an article, next to the blogs and newsletters you follow. You read it, save it or highlight it like anything else.

**Turning it on.** Posting is off unless you tick **Also let it post to your own feeds** when you connect the app. For an app you connected before, go to **Settings → AI apps**, choose **Disconnect**, then connect it again and tick the box. Apps that can post say **can post to your feeds** in that list. Posting is all it adds: the app still can't change or delete anything else.

**Feeds are made by name.** There's nothing to set up first. The app names the feed it posts to, and the first post to a new name makes that feed. Posting to the same name again adds to the same feed, so tell the app which name to use and it'll keep using it. Your feeds are listed in **Manage Sources → Your feeds**, where you can rename one, put it in a folder or a channel, or remove it. Renaming changes only what you see: the app keeps posting under the name it used first, so don't give it the new one.

**Only you see them.** These feeds stay private to your Skyreader account. They're never copied to the Atmosphere, even with Atmospheric sync on, and nobody else can follow them. A post only leaves if you share it yourself, like any other article.

**Stopping it.** Removing a feed in Manage Sources hides it, but if the app posts to that name again, the feed comes back. To stop the posts, disconnect the app (or revoke the script's password, below).

You can have up to 20 of these feeds, with up to 200 posts a day across all of them.

If your AI app can't run on a schedule by itself, you can still ask it to write and post a summary whenever you think of it.

### From a script

Anything that can send a web request can post too: a scheduled job, a GitHub Action, your own tool. In **Settings → AI apps**, under **Post from a script**, copy the address and choose **Create a password**. That password can post to your feeds and nothing else: it can't read your library. It's shown once; revoke it any time under **Settings → Other reader apps**.

Send one post per request, as JSON:

```sh
curl https://api.skyreader.app/api/push \
  -H "Authorization: Bearer YOUR-PASSWORD" \
  -H "Content-Type: application/json" \
  -d '{
    "feed": "Build reports",
    "title": "Nightly build: all green",
    "markdown": "**142** tests passed.\n\n- Deployed to staging",
    "guid": "build-2026-11-16"
  }'
```

- `feed` (required): the feed's name. A new name makes a new feed.
- `title` (required): the post's title.
- `markdown` or `html`: the body. Write either one, not both.
- `url`: a web page the post is about, if there is one.
- `guid`: your own id for the post. A `guid` already posted to that feed is ignored, so a retry never adds a second copy. A post can't be changed once it's sent.
- `author`, `publishedAt` (an ISO 8601 date): optional. A date in the future is treated as now.

A new post answers `201`; a repeated `guid` answers `200` with `"status": "duplicate"`. If you've parked the feed in Manage Sources, the answer says `"parked": true`: the post is kept, but you won't see it until you turn the feed back on. Posting needs the Supporter plan, like connecting an AI app.

## What it means for your data

When the app uses Skyreader, what it reads goes to that app and the company that runs it, under their terms, the same as anything else you share with it. Skyreader sends nothing on its own: only what the app asks for while you're using it.

## Disconnecting

**Settings → AI apps** lists every connected app. Choose **Disconnect** and its access ends right away. You can connect it again later.

An app that sits unused for a month is disconnected on its own and asks you to sign in again next time.

If your Supporter plan ends, connected apps stop working until it's back. Nothing needs to be reconnected.
