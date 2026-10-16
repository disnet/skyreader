import { describe, expect, it } from 'vitest';
import { checkUpload, uploadKind } from './fileUpload';

const MB = 1024 * 1024;

function fileOf(name: string, type: string, size = 1): File {
  const f = new File(['x'], name, { type });
  Object.defineProperty(f, 'size', { value: size });
  return f;
}

describe('uploadKind', () => {
  it('reads the MIME type or the extension', () => {
    expect(uploadKind(fileOf('a.bin', 'application/pdf'))).toBe('pdf');
    expect(uploadKind(fileOf('Book.EPUB', ''))).toBe('epub');
    expect(uploadKind(fileOf('photo.png', 'image/png'))).toBeNull();
  });
});

describe('checkUpload', () => {
  it('refuses a file over its kind’s limit', () => {
    const limits = { maxPdfUploadBytes: 10 * MB, maxEpubUploadBytes: 30 * MB };
    expect(checkUpload(fileOf('a.pdf', 'application/pdf', 11 * MB), limits)).toEqual({
      error: 'PDFs up to 10 MB can be uploaded.',
    });
    expect(checkUpload(fileOf('a.epub', 'application/epub+zip', 11 * MB), limits)).toEqual({
      kind: 'epub',
    });
  });

  it('refuses something that is neither', () => {
    expect(checkUpload(fileOf('a.txt', 'text/plain'))).toEqual({
      error: "That file isn't a PDF or an EPUB.",
    });
  });
});
