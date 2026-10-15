# One source filter

Status: shipped. Code: `frontend/src/lib/utils/sourceFilter.ts` (model, unit-tested) and
`frontend/src/lib/components/feed/SourcePicker.svelte` (the only picker).

## Why

Filtering had two axes that overlapped:

- **Sources**: All / Include only / Exclude only, over a flat list of subscriptions, plus a
  "Links from people you follow" checkbox that was really an account setting.
- **Type**: RSS Feeds, Newsletters, Bluesky Likes, Bluesky Bookmarks, Standard.site Documents.

Likes, bookmarks and follows' links are all "links surfaced on Bluesky", yet two lived under Type
and one under Sources. Type also mixed delivery plumbing (RSS vs standard.site) with provenance.
The two axes interacted in surprising ways: a type filter silently hid follows' links, and a manual
include channel dropped its type filter.

## Model

One filter: `sourceMode` (`all` | `include` | `exclude`) over `sourceKeys`. A key is a concrete
source (`rss~{rkey}`, `{rkey}~documents`, `bsky~follows`) or a **group key**, which stands for its
members as they are when the filter is read:

| Key                               | Members                                         |
| --------------------------------- | ----------------------------------------------- |
| `group~publications`              | RSS feeds and standard.site publications        |
| `group~newsletters`               | every newsletter sender                         |
| `group~likes` / `group~bookmarks` | the Bluesky likes / bookmarks subscription      |
| `group~feeds` / `group~documents` | not offered; only carry old type filters across |

So "only Newsletters" takes in next week's new sender, and "everything but Newsletters" keeps it
out. Matching code never sees a group: `expandSourceKeys` runs first (`feedView`'s `matchFilter`,
`unreadCounts`).

- **`all`** is Everything: every source, plus follows' links when the account setting
  (`follow_link_sync.in_everything`, set on Manage Sources) says so.
- **`exclude`** is every source _including_ follows' links, minus the keys. It doesn't depend on
  the setting, so a saved channel can't change meaning when the setting does. Leaving Everything
  for an exclude filter adds `bsky~follows` when Everything didn't have them, and an exclude filter
  that leaves out only what Everything does normalizes back to `all`.
- **`include`** is just the keys.

## Picker

A checklist where every row is checked when the filter shows it: **From Bluesky** (likes,
bookmarks, people you follow), **Newsletters** (the group, expandable to senders), **Publications**
(the group, then the reader's categories, then uncategorized feeds). Unchecking hides a row, "only"
shows just it, "Show everything" resets. A category has no key of its own and toggles its members.
The toolbar popover, the mobile sheet and both channel editors all render `SourcePicker`.

## Old channels

`upgradeChannelFilter` maps a stored channel to today's meaning, keyed on `filterVersion` (2):

- a type filter becomes group keys: an include of the types it named when they fall on whole
  groups, otherwise an exclude of the ones it didn't (follows' links excluded, as a type filter
  always hid them);
- an old exclude channel gets `bsky~follows` added, since exclude never used to show them;
- a smart (auto-rule) channel keeps its `typeFilter`, which `keysOfTypes` applies to the keys its
  rule recomputes.

It runs at read time (toolbar, unread counts, editors) and once persistently on load in
`filteredViewsStore`, which pushes the result to the backend. The channel config is opaque JSON in
D1, so there is no migration.
