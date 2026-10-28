---
title: Importing your library
description: Bring your saved articles, tags, archive, and highlights from Pocket, Omnivore, Instapaper, Readwise Reader, Matter, or Wallabag.
---

Coming from another read-later app? Bring your library with you. Open **Settings → Library & privacy → Saved articles** and choose **Import saves**, then pick the export file your app gave you.

## What comes across

- **Your saves**, dated when you saved them in the other app.
- **Your archive.** Anything you'd archived there goes straight to your Archive here, so your Queue holds only what you still meant to read.
- **Tags**, as tags (up to ten an article).
- **Highlights and their notes**, attached to their articles, wherever the export includes them.
- **A collection on your [Shelf](/guide/your-library/)** holding everything from the export, named for the app it came from, such as “Imported from Pocket”. A collection holds up to 2,000 articles, so a bigger library continues in “Imported from Pocket (2)”.

Articles already in your Library join the collection too. They keep their tags and archive state, and take the export's highlights only if you haven't highlighted them in Skyreader. Importing the same file twice adds nothing new, so if an import stops partway, run it again.

Imports don't count toward the monthly limit on saving links.

### The article text

An export carries links, not articles. Skyreader fetches the text of your newest few unread articles right away, and the rest the first time you open each one. Highlights show up in the text once it's there. A highlight whose passage has since changed on the page is still kept in your [Highlights](/guide/saving-and-highlights/#highlights) list.

## Finding your export

Choose the file as your app sent it: a zip is fine, and so are several files at once.

| App             | What to choose                                                                                                                                                                          |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pocket          | The zip Pocket emailed you. It holds a CSV of your saves and, if you highlighted anything, a file of highlights. The older `ril_export.html` export works too, without highlights.      |
| Omnivore        | The zip from Omnivore's export. Its highlights come across with their notes.                                                                                                            |
| Instapaper      | The CSV (or HTML) export from Instapaper's settings. Folders other than Unread and Archive become tags. Instapaper doesn't include highlights in its export.                            |
| Readwise Reader | The CSV from Reader's library export. To bring highlights, add the CSV from [readwise.io/export](https://readwise.io/export) alongside it; highlights are matched to articles by title. |
| Matter          | The `Archive.zip` from Matter's export. Articles you'd finished (out of your queue) go to your Archive. Highlights don't come across from Matter yet.                                   |
| Wallabag        | The JSON export from **All entries** (an export from Unread holds only your unread articles). Annotations come across as highlights, with their notes.                                  |

Pocket and Omnivore have shut down, so this works only with an export you saved before they did.

## If your saves are backed by Semble or Margin

When [Semble or Margin backs your saves](/guide/saving-and-highlights/#backing-your-saves-with-semble-or-margin), your Library is that collection, so an import adds every new article to it too. That collection is **public**: anyone can see what's in it. The import dialog says so before you start. Only the articles that import adds are copied in; the rest of your Library stays as it was. Articles already in the collection are skipped, without their tags or highlights from the export.
