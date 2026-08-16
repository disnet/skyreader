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
//
// Placement also decides whether a publication can be a linkblog target at all:
// an app that only renders what it wrote itself (pckt) can't host our link posts
// no matter how we write them — see `supported`.

import type { ContentFormat } from './linkblog-sync';

export interface PublicationApp {
  id: string;
  label: string;
  /** The format Skyreader writes for this app, or null if it can't write it. */
  format: ContentFormat | null;
  /**
   * True when the app renders only its own content lexicon, so `format` is the
   * one right answer and not a default to be overridden. Leaflet, pckt and
   * Offprint each read their own blocks and nothing else — a link written in
   * any other format lands in the publication and shows up as nothing.
   */
  formatLocked: boolean;
  /**
   * False when connecting a linkblog to this app's publication cannot work,
   * however correctly we write the records — see `unsupportedReason`. The
   * publication is still listed (hiding a user's own publication with no
   * explanation is worse), just not selectable.
   */
  supported: boolean;
  /** Why not, in the user's terms. Only set when `supported` is false. */
  unsupportedReason?: string;
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
    formatLocked: true,
    supported: true,
    nsidPrefix: 'pub.leaflet.',
    host: 'leaflet.pub',
  },
  // pckt builds its site from the posts pckt itself wrote — it doesn't watch the
  // firehose for records that appear in a repo it already knows. So a link post
  // Skyreader writes into a pckt publication is a correct `blog.pckt.content`
  // document with a correct `blog.pckt.document` companion that pckt's site
  // simply never picks up. There's nothing to fix on our side and no format that
  // helps, so the publication is listed but can't be connected.
  {
    id: 'pckt',
    label: 'pckt',
    format: 'pckt',
    formatLocked: true,
    supported: false,
    unsupportedReason:
      "pckt only shows posts written in pckt, so links Skyreader adds here wouldn't appear on your pckt site.",
    nsidPrefix: 'blog.pckt.',
    host: 'pckt.blog',
  },
  {
    id: 'offprint',
    label: 'Offprint',
    format: 'offprint',
    formatLocked: true,
    supported: true,
    nsidPrefix: 'app.offprint.',
    host: 'offprint.app',
  },
  // markpub reads Markdown, which is also what a publication we can't place gets
  // written as, so its format stays a choice rather than a lock.
  {
    id: 'markpub',
    label: 'markpub',
    format: 'markpub',
    formatLocked: false,
    supported: true,
    nsidPrefix: 'at.markpub.',
    host: 'markpub.at',
  },
  // Skyreader renders Greengale documents but has no writer for them, so a
  // Greengale publication is labeled and left to the user's format choice.
  {
    id: 'greengale',
    label: 'Greengale',
    format: null,
    formatLocked: false,
    supported: true,
    nsidPrefix: 'app.greengale.',
    host: 'greengale.app',
  },
];

function publicApp({
  id,
  label,
  format,
  formatLocked,
  supported,
  unsupportedReason,
}: KnownApp): PublicationApp {
  return { id, label, format, formatLocked, supported, unsupportedReason };
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
