---
title: AI apps
description: Connect Claude, ChatGPT or another AI app to Skyreader, so it can search and read what you've saved and highlighted, go through what's unread in your feeds, and post to feeds of your own.
---

You can let an AI app work with your reading. Ask Claude what you've saved about a topic, have it pull together your highlights on a question, find what you've read that disagrees with the article in front of you, or sort a pile of unread posts by topic so you can choose where to start. The app reads your Skyreader library and feeds when you ask; it can't change anything in them. If you want, you can also let it post to feeds of your own, so a weekly look back at your highlights arrives with everything else you read.

Connecting an app is part of the [Supporter plan](/supporter/). [Asking about an article](#asking-about-an-article) works on any plan.

## Connecting an app

Skyreader connects through MCP (Model Context Protocol), the standard most AI apps use for outside tools. Apps call these **connectors**, **integrations** or **MCP servers**. The address is:

```
https://api.skyreader.app/mcp
```

It's also in **Settings → AI apps**, with a copy button.

1. In your AI app, add a custom connector (or MCP server) and paste the address. In Claude, that's **Settings → Connectors → Add custom connector**.
2. The app opens a Skyreader page. Sign in if you're asked to, the same way you sign in to Skyreader.
3. Skyreader shows which app is asking and where its access will go. To let it post to feeds of your own too, tick **Also let it create feeds for you** (see [below](#posting-to-your-own-feeds)). Choose **Allow**.

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
- **List what's unread in your feeds**, newest first: the blogs, newsletters and other sources you follow, with each post's title, link, source, date and opening lines. It counts unread the way Skyreader does, so the number matches what you see. It can narrow to one source, or to posts from today.
- **Read a post from your feeds**, all of it when the feed includes the whole article. Some feeds only send a summary; then the app gets that and the link.
- **Post to your own feeds**, only if you ticked the box when you connected it. See below.

When Skyreader adds to this list, some apps keep using the old one until you disconnect and reconnect Skyreader in the app.

It can't save, delete, mark read, or change your subscriptions: a post it reads stays unread until you read it. It sees only your own library and the sources you follow, not other people's. Posts from Atmosphere sources, such as Leaflet blogs, aren't in its unread list yet.

## Asking about an article

When you're reading something and want to talk it over with an AI app, open **Share** in the reader and choose **Ask Claude**. A new chat opens with a first message already written: the article's title and link, a line telling the app how to find it and your highlights in Skyreader when it can, and a request to ask what you make of it and push back on your reading rather than summarize it. Some apps wait for you to press send, so you can add your own question or change the request first; others send it straight away.

The app can always start from the link. If you've connected Skyreader to it (above), it can also read the text Skyreader has and your highlights and notes on the article, which helps with a saved article whose page has changed, a paywalled post you saved the text of, or an upload with no link at all.

**Choosing your app.** Claude is the one-tap choice to start with. To change it, go to **Settings → AI apps → Ask about an article** and pick ChatGPT, Perplexity, Grok, Le Chat, or the Claude desktop app. The others stay a tap further, under **Ask another agent**. The choice is kept on each device, so your phone can open a different app from your laptop.

**An app that isn't listed.** Under **Ask another agent**, **Copy the prompt** copies the same first message, to paste into Gemini or any other app. If your app starts a chat from a link, pick **Your own link** in Settings and give the address with `{prompt}` where the message goes, for example `https://kagi.com/assistant?q={prompt}`.

**Turning it off.** Pick **Don't offer it** and the two entries leave the Share menu.

The prompt carries the article's link and, for a saved article or a feed post, Skyreader's own name for it. It goes only to the app you open, the same as anything you paste into it.

## Posting to your own feeds

An AI app you've allowed to post can write into Skyreader, not just read from it. Ask it for something like "every Monday, pull together what I highlighted last week, with the questions it raises, and post it to my Weekly look back feed", and the post shows up in your feeds as an article, next to the blogs and newsletters you follow. You read it, save it or highlight it like anything else.

**Turning it on.** Posting is off unless you tick **Also let it create feeds for you** when you connect the app. For an app you connected before, go to **Settings → AI apps**, choose **Disconnect**, then connect it again and tick the box. Apps that can post say **can post to your feeds** in that list. Posting is all it adds: the app still can't change or delete anything else.

**Feeds are made by name.** There's nothing to set up first. The app names the feed it posts to, and the first post to a new name makes that feed. Posting to the same name again adds to the same feed, so tell the app which name to use and it'll keep using it. Your feeds are listed in **Manage Sources → Your feeds**, where you can rename one, put it in a folder or a channel, or remove it. Renaming changes only what you see: the app keeps posting under the name it used first, so don't give it the new one.

**Only you see them.** These feeds stay private to your Skyreader account. They're never copied to the Atmosphere, even with Atmospheric sync on, and nobody else can follow them. A post only leaves if you share it yourself, like any other article.

**Stopping it.** Removing a feed in Manage Sources hides it, but if the app posts to that name again, the feed comes back. To stop the posts, disconnect the app (or revoke the script's password, below).

There's no separate limit on how many of these feeds you have: they count toward your plan's sources like any other feed. Posts are limited to 200 a day across all of them.

Together with your unread list, this makes a morning map: "go through my unread feeds, group what's new by topic, and post it to a feed called Morning Map, with a line on what each group is about." You still choose what to read.

If your AI app can't run on a schedule by itself, you can still ask it to write and post one whenever you think of it.

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
