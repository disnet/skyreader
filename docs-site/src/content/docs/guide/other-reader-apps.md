---
title: Other reader apps
description: Read your Skyreader sources in NetNewsWire, Reeder, ReadKit or Unread, with read and starred state kept in step.
---

If you already have an RSS app you love, you can keep it. Skyreader works as a sync service for apps that speak the Google Reader API, such as NetNewsWire, Reeder, ReadKit and Unread. The app shows your sources, and what you read or star there is read or saved in Skyreader too.

Your newsletters, Bluesky likes and bookmarks, and the Atmosphere publications you follow (standard.site blogs like Leaflet) come along with your feeds, since they're sources like any other.

## Connecting an app

1. In Skyreader, open **Settings** and find **Other reader apps**.
2. Type the app's name and choose **Create password**. Copy the password: it's shown once.
3. In your app, add an account of type **FreshRSS** or **Google Reader** (the name depends on the app).
4. Enter the **server address** shown in Settings, your **handle** as the username, and the password you just made.

Some apps ask only for the server and add the rest of the address themselves. If signing in fails with the full address, enter just `https://api.skyreader.app`.

Make a separate password for each app. To sign an app out, **Revoke** its password in Settings. The list shows when each password was last used.

An app password only lets an app read your sources, change your subscriptions and folders, mark items read, unread, starred or unstarred, and read your highlights and notes (for the [Obsidian plugin](/guide/notes-and-reference-managers/)). It can't change your settings or sign in to Skyreader on the web.

## What syncs

- **Subscriptions and folders.** Each source appears with its folder. Add a feed, unsubscribe, rename a source or move it between folders in either place, and the other catches up on its next sync. Publications in the Atmosphere are followed from Skyreader; once followed, you can rename, file or unsubscribe from them in the app too.
- **Articles.** Each source's newest 100 articles, the same ones Skyreader shows. Older articles stay in Skyreader's archive.
- **Publications.** Each one you follow appears as a feed, with its newest 100 posts. The app shows the text of each post; for anything richer, open it on the publication.
- **Read and unread.** Marking an article read or unread in the app does the same in Skyreader, and the other way around. Unread counts match.
- **Starred.** Starring an article in the app saves it to your Library in Skyreader, and unstarring removes the save. Articles you saved in Skyreader from a source show as starred in the app. If you back your saves with Semble or Margin, a star made in the app lands in that public collection like any other save.

Articles you saved by link don't appear in other apps.

## If starring or subscribing doesn't work

Starring and subscription changes act as you, so they use your Skyreader sign-in on the web. That sign-in lapses after a while unused. If the app reports an error when you star or change a subscription, open Skyreader in a browser and sign in again, then try again.
