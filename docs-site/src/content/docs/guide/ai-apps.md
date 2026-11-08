---
title: AI apps
description: Connect Claude, ChatGPT or another AI app to Skyreader, so it can search and read what you've saved and highlighted.
---

You can let an AI app work with your reading. Ask Claude what you've saved about a topic, have it pull together your highlights on a question, or summarize an article you saved last month. The app reads your Skyreader library when you ask; it can't change anything in it.

This is part of the [Supporter plan](/supporter/).

## Connecting an app

Skyreader connects through MCP (Model Context Protocol), the standard most AI apps use for outside tools. Apps call these **connectors**, **integrations** or **MCP servers**. The address is:

```
https://api.skyreader.app/mcp
```

It's also in **Settings → AI apps**, with a copy button.

1. In your AI app, add a custom connector (or MCP server) and paste the address. In Claude, that's **Settings → Connectors → Add custom connector**.
2. The app opens a Skyreader page. Sign in if you're asked to, the same way you sign in to Skyreader.
3. Skyreader shows which app is asking and where its access will go. Choose **Allow**.

You don't make or paste a password: the app gets its own access, which only works for reading through this connection.

In Claude Code, add it from a terminal and sign in when it prompts you:

```
claude mcp add --transport http skyreader https://api.skyreader.app/mcp
```

## What the app can do

- **Search** what you've read, saved and highlighted, the same search as in Skyreader.
- **List your saves**, newest first, or the ones in a Shelf collection.
- **Read a saved article's text.** Very long articles are cut off after about 30,000 characters.
- **List your highlights and notes**, page by page, optionally only what changed since a date.
- **See your Shelf collections.**

It can't save, delete, mark read, change your subscriptions or see your feeds. It sees only your own library, not other people's.

## What it means for your data

When the app uses Skyreader, what it reads goes to that app and the company that runs it, under their terms, the same as anything else you share with it. Skyreader sends nothing on its own: only what the app asks for while you're using it.

## Disconnecting

**Settings → AI apps** lists every connected app. Choose **Disconnect** and its access ends right away. You can connect it again later.

An app that sits unused for a month is disconnected on its own and asks you to sign in again next time.

If your Supporter plan ends, connected apps stop working until it's back. Nothing needs to be reconnected.
