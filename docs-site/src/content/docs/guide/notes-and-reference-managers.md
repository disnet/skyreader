---
title: Notes and reference managers
description: Keep your Skyreader highlights and notes in Obsidian and Zotero, with citation details, as you read.
---

What you highlight and write in Skyreader can follow you into the tools you write with. New highlights and notes arrive on their own, each with the article's citation details: its link, author, dates, and a DOI or arXiv id where a paper has one.

Syncing is part of the [Supporter plan](/supporter/). Downloading everything once, as Markdown or BibTeX, is on every plan: see [Exporting](/guide/saving-and-highlights/#exporting).

## Obsidian

The Skyreader plugin keeps one note per article in your vault.

1. In Obsidian, open **Settings → Community plugins**, choose **Browse**, and install **Skyreader**. Turn it on.
2. In Skyreader, open **Settings → Notes & references** and choose **Create a password for Obsidian**. Copy the password: it's shown once.
3. In Obsidian, open the plugin's settings and paste the password.

The plugin syncs when Obsidian starts and every 30 minutes after, or when you run **Sync highlights now** from the command palette.

### What to sync

- **Everything highlighted.** Every article you highlight or write a note on gets a note, whether you saved it or not.
- **Chosen collections.** Every save in the Shelf collections you pick gets a note, highlighted or not, and one you add to a collection later arrives on the next sync. Articles outside them stay out.

### Your notes stay yours

Each note has a part Skyreader keeps up to date, between two markers that reading view hides: the title, citation details, and your highlights and notes in reading order. Write anything you like above or below it, and add your own properties: a sync never touches them. Edit inside the markers and the next change in Skyreader replaces it.

Rename or move a note and it stays synced. Delete one and it comes back the next time that article's highlights change.

The note's properties carry `title`, `author`, `url`, `doi`, `arxiv`, `published` and `saved`, ready for a Dataview query or a citation plugin.

## Zotero

Skyreader adds your saves to your Zotero library as references, and keeps your highlights and notes in a note on each.

1. At [zotero.org/settings/keys](https://www.zotero.org/settings/keys/new), make a new key with **Allow library access** and **Allow write access** turned on. Copy it.
2. In Skyreader, open **Settings → Notes & references**, paste the key under **Zotero**, and choose **Connect**.

Skyreader syncs about every 15 minutes, or when you choose **Sync now**.

### What to sync

- **Everything.** Every save, and every article you highlighted without saving.
- **Chosen collections.** Only the saves in the Shelf collections you pick, highlighted or not.

### What arrives

Each article becomes an item in a **Skyreader** collection: a preprint for an arXiv paper, a journal article for anything else with a DOI, and otherwise a web page, document or book. It carries the title, authors, publication date, link, and the day you saved it as the accessed date.

Your highlights and notes go in a note on the item, titled **Skyreader highlights**, and that note is updated when they change. Write your own notes in a note of their own: Skyreader rewrites only its note.

If a paper is already in your library with the same DOI, the note goes on that item instead of a second copy.

An item is yours once it's in Zotero. Edit it as you like: Skyreader doesn't change it again. Delete it and it isn't added back. Removing a save in Skyreader leaves its item in Zotero, and so does disconnecting. Removing a highlight takes it out of the note.

## The Obsidian password

The plugin signs in with an app password, like [other reader apps](/guide/other-reader-apps/). It's listed with your other app passwords in **Settings → Other reader apps**: revoke it there to stop the sync.
