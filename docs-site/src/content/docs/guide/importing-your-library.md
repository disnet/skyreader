---
title: Importing your library
description: Bring your saved articles, tags, archive, and highlights from Pocket, Omnivore, Instapaper, Readwise Reader, Matter, or Wallabag, and your book highlights from Kindle or Readwise.
---

Coming from another read-later app? Bring your library with you. Open **Settings → Library & privacy → Saved articles** and choose **Import saves**, then pick the export file your app gave you.

Highlighted books on a Kindle? Those come across too: see [Books from Kindle or Readwise](#books-from-kindle-or-readwise).

## What comes across

- **Your saves**, dated when you saved them in the other app.
- **Your archive.** Anything you'd archived there goes straight to your Archive here, so your Queue holds only what you still meant to read. You can change this before you import (see below).
- **Tags**, as tags (up to ten an article).
- **Highlights and their notes**, attached to their articles, wherever the export includes them.
- **A collection on your [Shelf](/guide/your-library/)** holding everything you import, named for the app it came from, such as “Imported from Pocket”. A collection holds up to 2,000 articles, so a bigger library continues in “Imported from Pocket (2)”.

## Choosing what comes in

Once Skyreader has read your file, it lists every article it found, all ticked. Untick any you'd rather leave behind, or untick **All articles** and tick just the few you want. An export from more than one app is listed app by app, each with its own tick box. Articles you've already saved in Skyreader are marked **Already saved**, and **Untick the ones already saved** leaves them all out.

Below the list, choose where the articles land in your [Queue](/guide/your-library/), the list of what to read next:

- **As in Pocket** (or whichever app): unread articles go to your Inbox and archived ones to your Archive, the way you left them. This is the default, and shows only when your export has both.
- **Inbox**: every new article lands unread, ready to read next.
- **Archive, Shelf only** (just **Archive** if you untick the Shelf box below): every new article goes straight to your Archive, so your Inbox stays as it was, and the articles wait in their Shelf collection until you go looking.

**Also put them on your Shelf** files what you import in the “Imported from …” collection. It's on by default; untick it if you'd rather not have the collection. The articles are in your Library and searchable either way.

Articles already in your Library join the collection too (unless you untick the Shelf box). They keep their tags and archive state, and take the export's highlights only if you haven't highlighted them in Skyreader. Importing the same file twice adds nothing new, so if an import stops partway, run it again.

Imports don't count toward the monthly limit on saving links.

### The article text

An export carries links, not articles. Skyreader fetches the text of your newest few unread articles right away, and the rest the first time you open each one. Highlights show up in the text once it's there. A highlight whose passage has since changed on the page is still kept in your [Highlights](/guide/saving-and-highlights/#highlights) list.

## Books from Kindle or Readwise

Your book highlights can live here alongside your articles, so they turn up in your [review deck](/guide/saving-and-highlights/#the-review-deck), in search, and in your [Highlights](/guide/saving-and-highlights/#highlights) list. Import them the same way, with **Import saves**.

**What a book looks like here.** Skyreader doesn't have the book itself, only what you highlighted. Each book becomes one item on your [Shelf](/guide/your-library/), with its title and author. Open it and you see your highlighted passages, one after another in the order they come in the book, each highlighted, with your notes in the margin. Books go to your Archive, so they sit on your Shelf rather than in your Inbox; choose **Inbox** before you import if you'd rather have them there.

**Which file to choose:**

- **A Kindle e-reader:** plug it into your computer with its USB cable. It shows up like a USB drive. In its `documents` folder, choose `My Clippings.txt`. That one file holds every highlight and note from every book on that Kindle.
- **The Kindle app on a phone, tablet or computer:** the app doesn't keep a file you can export. If you use [Readwise](https://readwise.io), which collects Kindle highlights from the app too, import its CSV instead (next item).
- **Readwise:** the CSV from [readwise.io/export](https://readwise.io/export). Books in it (Kindle, Apple Books and others) come across as books. Its article highlights are matched to articles from your Readwise Reader export, as in the table below.

If a book is in both files, choose both: it comes across as one book with the highlights from each.

**Importing again.** Your Kindle file keeps growing as you read, so import it whenever you like. A book already here gains only the passages it didn't have. A highlight you removed in Skyreader stays removed. Two things about Kindle's file to know:

- When you stretch a highlight on your Kindle, the file keeps both the short and the long version. Skyreader keeps only the longer one. If you'd already imported the shorter one, the longer one isn't added.
- Deleting a highlight on your Kindle doesn't take it out of `My Clippings.txt`, so it still comes across. Remove it here if you don't want it.

A note you wrote without highlighting anything has nothing to attach to, so it's left out, and the import says how many.

Book highlights are private to Skyreader, even if your saves are [backed by Semble or Margin](#if-your-saves-are-backed-by-semble-or-margin): a book has no web address to put in that collection.

## Finding your export

Choose the file as your app sent it: a zip is fine, and so are several files at once.

| App             | What to choose                                                                                                                                                                                                                                                                                                      |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pocket          | The zip Pocket emailed you. It holds a CSV of your saves and, if you highlighted anything, a file of highlights. The older `ril_export.html` export works too, without highlights.                                                                                                                                  |
| Omnivore        | The zip from Omnivore's export. Its highlights come across with their notes.                                                                                                                                                                                                                                        |
| Instapaper      | The CSV (or HTML) export from Instapaper's settings. Folders other than Unread and Archive become tags. Instapaper doesn't include highlights in its export.                                                                                                                                                        |
| Readwise Reader | The CSV from Reader's library export. Articles new to Skyreader from your Shortlist come across with a `shortlist` tag, so you can still find them in your Queue. To bring highlights, add the CSV from [readwise.io/export](https://readwise.io/export) alongside it; highlights are matched to articles by title. |
| Matter          | The `Archive.zip` from Matter's export. Articles you'd finished (out of your queue) go to your Archive. Highlights don't come across from Matter yet.                                                                                                                                                               |
| Wallabag        | The JSON export from **All entries** (an export from Unread holds only your unread articles). Annotations come across as highlights, with their notes.                                                                                                                                                              |
| Kindle          | `My Clippings.txt` from the `documents` folder of your Kindle e-reader. See [Books from Kindle or Readwise](#books-from-kindle-or-readwise).                                                                                                                                                                        |

Pocket and Omnivore have shut down, so this works only with an export you saved before they did.

## If your saves are backed by Semble or Margin

When [Semble or Margin backs your saves](/guide/saving-and-highlights/#backing-your-saves-with-semble-or-margin), your Library is that collection, so an import adds every new article to it too. That collection is **public**: anyone can see what's in it. The import dialog says so before you start. Only the articles that import adds are copied in; the rest of your Library stays as it was. Articles already in the collection are skipped, without their tags or highlights from the export.

### A large import takes a while to copy

Each article copied into the collection is a new record in your Atmosphere account, and the server that holds your account (your PDS) caps how many records any app can write in an hour and in a day. On Bluesky's servers that's several hundred articles an hour and a few thousand a day. Your posts count against the same cap.

So the copy runs in the background on Skyreader's servers, at the pace your account allows. It stops before it uses up your allowance, which leaves room for you to keep posting, and carries on when the limit resets. A few thousand articles can take a day or more. You don't need to keep Skyreader open: every article is in your Library here straight away, and **Settings → Library & privacy → Saved articles** shows how many are still to copy.

Changed your mind? **Pause** there stops the copy: what's already copied stays in the collection, and the rest stay private to Skyreader. **Resume** picks it up again. If some of your saves never made it into the collection (a copy you paused, or one that stopped partway), the same place says how many and offers **Copy them in**.
