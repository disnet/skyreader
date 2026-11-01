export interface TierLimits {
  /** Feeds Skyreader actively services (polls + shows). Overflow is parked. */
  maxSubscriptions: number;
  /**
   * Hard ceiling on total mirrored rows (active + parked) we'll materialize in
   * D1 for one user. Parked feeds are otherwise unbounded — a user with a huge
   * PDS subscription collection could mirror tens of thousands of rows — so this
   * caps storage/write cost. Records beyond it are dropped (not mirrored); they
   * still live on the PDS and re-appear if the user frees room or upgrades.
   */
  maxMirroredSubscriptions: number;
  maxUrlSavesPerMonth: number;
  /**
   * A private email address whose mail lands in the reader as newsletter
   * subscriptions (services/newsletters.ts). Checked when the address is issued
   * and again on every inbound message, so a lapsed plan stops ingesting.
   */
  newsletterInbox: boolean;
  /**
   * Full-text search over everything the reader has read, saved or highlighted
   * (durable-objects/search-index.ts). Checked on every search and before any
   * write nudges the index, so a lapsed plan stops both.
   */
  fullTextSearch: boolean;
  /**
   * Reading PDFs and EPUBs: saving one by URL (its text reflowed for the reader)
   * and uploading one (routes/saved-pdf.ts). Checked before every parse, so a
   * lapsed plan keeps the files it saved but can't add more.
   */
  pdfSaves: boolean;
  /** Largest PDF upload, in bytes. The pdf-extractor Worker refuses anything bigger. */
  maxPdfUploadBytes: number;
  /**
   * Largest EPUB, uploaded or saved by link, in bytes. The same as a PDF's:
   * both stream into R2 and are read from there, never held whole.
   */
  maxEpubUploadBytes: number;
  /** Uploads (PDF or EPUB) per calendar month (UTC). URL saves count as URL saves instead. */
  maxPdfUploadsPerMonth: number;
  /** Total bytes of originals kept in R2 (PDFs uploaded or saved by link, uploaded EPUBs), plus the pictures snapshots keep. Deleting a save frees its file and pictures. */
  maxPdfStorageBytes: number;
  /**
   * Keeping the pictures a saved article shows with its snapshot
   * (services/archive/snapshot-images.ts), counted against maxPdfStorageBytes.
   * Checked at each capture, so a lapsed plan keeps the pictures it captured but
   * captures no new ones; text snapshots are on every plan.
   */
  snapshotImages: boolean;
  /**
   * Saved searches: channels whose query is matched against every new item
   * (durable-objects/percolator.ts). 0 = not in the plan. Past the cap, the
   * oldest queries keep matching and the newer ones wait.
   */
  maxSavedSearches: number;
  /**
   * Live integrations: notes apps and reference managers that keep receiving
   * new highlights and notes (routes/highlight-sync.ts, routes/zotero.ts).
   * Checked on every sync, so a lapsed plan stops syncing; the one-time export
   * stays on every plan.
   */
  liveIntegrations: boolean;
}

const MB = 1024 * 1024;

const TIER_MAP: Record<string, TierLimits> = {
  free: {
    maxSubscriptions: 100,
    maxMirroredSubscriptions: 1000,
    maxUrlSavesPerMonth: 100,
    newsletterInbox: false,
    fullTextSearch: false,
    pdfSaves: false,
    maxPdfUploadBytes: 0,
    maxEpubUploadBytes: 0,
    maxPdfUploadsPerMonth: 0,
    maxPdfStorageBytes: 0,
    snapshotImages: false,
    maxSavedSearches: 0,
    liveIntegrations: false,
  },
  supporter: {
    maxSubscriptions: 1000,
    maxMirroredSubscriptions: 5000,
    maxUrlSavesPerMonth: 1000,
    newsletterInbox: true,
    fullTextSearch: true,
    pdfSaves: true,
    // The extractor's own cap (pdf-extractor/src/extract.ts MAX_PDF_BYTES).
    maxPdfUploadBytes: 50 * MB,
    maxEpubUploadBytes: 50 * MB,
    maxPdfUploadsPerMonth: 200,
    maxPdfStorageBytes: 2048 * MB,
    snapshotImages: true,
    maxSavedSearches: 25,
    liveIntegrations: true,
  },
};

export const ALL_TIERS = Object.keys(TIER_MAP);

export function isValidTier(tier: string): boolean {
  return tier in TIER_MAP;
}

export function getLimitsForTier(tier: string): TierLimits {
  return TIER_MAP[tier] ?? TIER_MAP.free;
}
