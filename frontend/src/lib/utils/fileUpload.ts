// Shared checks for a PDF or EPUB handed to Skyreader as a file, by the Add
// panel's picker or a drop anywhere in the app (GlobalFileDrop).

export type UploadKind = 'pdf' | 'epub';

interface UploadLimits {
  maxPdfUploadBytes?: number;
  maxEpubUploadBytes?: number;
}

const MB = 1024 * 1024;

export function uploadKind(file: File): UploadKind | null {
  if (file.type === 'application/pdf' || /\.pdf$/i.test(file.name)) return 'pdf';
  if (file.type === 'application/epub+zip' || /\.epub$/i.test(file.name)) return 'epub';
  return null;
}

export function uploadLimitsMb(limits?: UploadLimits | null): { pdf: number; epub: number } {
  return {
    pdf: Math.round((limits?.maxPdfUploadBytes ?? 50 * MB) / MB),
    epub: Math.round((limits?.maxEpubUploadBytes ?? 50 * MB) / MB),
  };
}

/** The file's kind, or the line to show the reader when it can't be uploaded. */
export function checkUpload(
  file: File,
  limits?: UploadLimits | null
): { kind: UploadKind } | { error: string } {
  const kind = uploadKind(file);
  if (!kind) return { error: "That file isn't a PDF or an EPUB." };
  const max = uploadLimitsMb(limits);
  if (kind === 'pdf' && file.size > (limits?.maxPdfUploadBytes ?? 50 * MB)) {
    return { error: `PDFs up to ${max.pdf} MB can be uploaded.` };
  }
  if (kind === 'epub' && file.size > (limits?.maxEpubUploadBytes ?? 50 * MB)) {
    return { error: `EPUBs up to ${max.epub} MB can be uploaded.` };
  }
  return { kind };
}
