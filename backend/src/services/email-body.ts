// The email-body scope: the wrapper the reader keys its newsletter type reset on
// (frontend app.css, `.sr-email-body`). Email templates size text through markup
// the sanitizer can't tell from article structure — an <h1> as a 12px footer,
// <small> around whole sections — so the body carries a scope that resets it,
// and every surface that renders the body (card, reader, save, magazine,
// offline copy) gets it.
//
// No imports on purpose: frontend/src/lib/utils/newsletters.ts keeps its own
// copy (it wraps legacy rows the same way), and its tests import this file to
// hold the two byte-compatible.

export const EMAIL_BODY_CLASS = 'sr-email-body';

const EMAIL_BODY_OPEN = `<div class="${EMAIL_BODY_CLASS}">`;

// An opening wrapper however it was serialized: leading whitespace or a BOM,
// either quote style (or none), other attributes or classes beside it. The
// class has to be a whole token: `sr-email-body-wrapper` is a template's own.
export function wrapperStart(cls: string): RegExp {
  return new RegExp(
    `^[\\s\\uFEFF]*<div\\b[^>]*\\sclass\\s*=\\s*(?:(["'])(?:[^"']*\\s)?${cls}(?:\\s[^"']*)?\\1|${cls}(?=[\\s>]))[^>]*>`,
    'i'
  );
}

const EMAIL_BODY_START = wrapperStart(EMAIL_BODY_CLASS);

export function isEmailBody(html: string | null | undefined): boolean {
  return !!html && EMAIL_BODY_START.test(html);
}

/** Wrap a newsletter body in the email-body scope; idempotent. */
export function wrapEmailBody(html: string): string {
  if (!html || isEmailBody(html)) return html;
  return `${EMAIL_BODY_OPEN}${html}</div>`;
}
