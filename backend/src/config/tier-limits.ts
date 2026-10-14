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
   * Reading PDFs: saving a PDF by URL (its text reflowed for the reader) and
   * uploading one (routes/saved-pdf.ts). Checked before every parse, so a lapsed
   * plan keeps the PDFs it saved but can't add more.
   */
  pdfSaves: boolean;
  /** Largest PDF upload, in bytes. The pdf-extractor Worker refuses anything bigger. */
  maxPdfUploadBytes: number;
  /** Uploads per calendar month (UTC). URL saves of PDFs count as URL saves instead. */
  maxPdfUploadsPerMonth: number;
  /** Total bytes of uploaded originals kept in R2. Deleting a save frees its file. */
  maxPdfStorageBytes: number;
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
    maxPdfUploadsPerMonth: 0,
    maxPdfStorageBytes: 0,
  },
  supporter: {
    maxSubscriptions: 1000,
    maxMirroredSubscriptions: 5000,
    maxUrlSavesPerMonth: 1000,
    newsletterInbox: true,
    fullTextSearch: true,
    pdfSaves: true,
    // The extractor's own cap (pdf-extractor/src/extract.ts MAX_PDF_BYTES).
    maxPdfUploadBytes: 10 * MB,
    maxPdfUploadsPerMonth: 200,
    maxPdfStorageBytes: 2048 * MB,
  },
};

export const ALL_TIERS = Object.keys(TIER_MAP);

export function isValidTier(tier: string): boolean {
  return tier in TIER_MAP;
}

export function getLimitsForTier(tier: string): TierLimits {
  return TIER_MAP[tier] ?? TIER_MAP.free;
}
