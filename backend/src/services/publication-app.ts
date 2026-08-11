// Which standard.site app a publication belongs to.
//
// `site.standard.publication` is a shared collection — Leaflet, pckt, Offprint,
// markpub and Greengale all write the same record type — so the record itself
// says nothing about which app created it. The settings picker still needs to
// tell the user *what* each of their publications is, so we infer it from two
// signals, strongest first:
//
//  1. The content `$type` of documents already published there. Every app writes
//     its own content lexicon, so this is authoritative when the publication has
//     posts.
//  2. The publication's own `url` host. NSIDs are reverse-DNS, so each app's
//     domain falls straight out of its lexicon authority (`pub.leaflet.*` →
//     leaflet.pub) — no guessing at hostnames. Only used when there are no posts
//     to read the format off.
//
// Anything we can't place gets no app label; the UI falls back to showing the
// publication's host, which is honest and still recognizable.

import type { ContentFormat } from './linkblog-sync';

export interface PublicationApp {
  id: string;
  label: string;
  /** The format Skyreader writes for this app, or null if it can't write it. */
  format: ContentFormat | null;
}

interface KnownApp extends PublicationApp {
  /** Lexicon authority for the app's content records (`pub.leaflet.content`). */
  nsidPrefix: string;
  /** The same authority read as a domain — see the note above. */
  host: string;
}

const KNOWN_APPS: KnownApp[] = [
  {
    id: 'leaflet',
    label: 'Leaflet',
    format: 'leaflet',
    nsidPrefix: 'pub.leaflet.',
    host: 'leaflet.pub',
  },
  { id: 'pckt', label: 'pckt', format: 'pckt', nsidPrefix: 'blog.pckt.', host: 'pckt.blog' },
  {
    id: 'offprint',
    label: 'Offprint',
    format: 'offprint',
    nsidPrefix: 'app.offprint.',
    host: 'offprint.app',
  },
  {
    id: 'markpub',
    label: 'markpub',
    format: 'markpub',
    nsidPrefix: 'at.markpub.',
    host: 'markpub.at',
  },
  // Skyreader renders Greengale documents but has no writer for them, so a
  // Greengale publication is labeled and left to the user's format choice.
  {
    id: 'greengale',
    label: 'Greengale',
    format: null,
    nsidPrefix: 'app.greengale.',
    host: 'greengale.app',
  },
];

function publicApp({ id, label, format }: KnownApp): PublicationApp {
  return { id, label, format };
}

/** The app that owns a document's content lexicon, e.g. `pub.leaflet.content`. */
export function appForContentType(contentType: string | undefined): PublicationApp | null {
  if (!contentType) return null;
  const app = KNOWN_APPS.find((candidate) => contentType.startsWith(candidate.nsidPrefix));
  return app ? publicApp(app) : null;
}

/** The app whose domain serves this publication's site, if we recognize it. */
export function appForUrl(url: string | undefined): PublicationApp | null {
  if (!url) return null;
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
  const app = KNOWN_APPS.find(
    (candidate) => host === candidate.host || host.endsWith(`.${candidate.host}`)
  );
  return app ? publicApp(app) : null;
}
