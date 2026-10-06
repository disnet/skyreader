// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import {
  EMAIL_BODY_CLASS,
  isEmailBody,
  isEmailLead,
  wrapEmailBody,
  wrapEmailLead,
} from './newsletters';
import * as backendEmailBody from '../../../../backend/src/services/email-body';
import { sanitizeHtml } from './sanitize';

describe('wrapEmailBody', () => {
  it('wraps a body in the email-body scope', () => {
    expect(wrapEmailBody('<p>Hi</p>')).toBe('<div class="sr-email-body"><p>Hi</p></div>');
  });

  it('is idempotent, including across a sanitize round-trip', () => {
    const once = sanitizeHtml(wrapEmailBody('<table><tr><td><h1>Hi</h1></td></tr></table>'));
    expect(wrapEmailBody(once)).toBe(once);
  });

  it('recognizes a wrapper however it was serialized', () => {
    const variants = [
      '\n  <div class="sr-email-body"><p>Hi</p></div>',
      '\uFEFF<div class="sr-email-body"><p>Hi</p></div>',
      "<div class='sr-email-body'><p>Hi</p></div>",
      '<div data-x="1" class="reader sr-email-body"><p>Hi</p></div>',
      '<DIV CLASS="sr-email-body"><p>Hi</p></DIV>',
    ];
    for (const html of variants) {
      expect(isEmailBody(html)).toBe(true);
      expect(wrapEmailBody(html)).toBe(html);
    }
    expect(isEmailBody('<p>Hi</p><div class="sr-email-body"></div>')).toBe(false);
    expect(isEmailBody('<div class="sr-email-bodywork"><p>Hi</p></div>')).toBe(false);
    expect(isEmailBody('<div class=sr-email-body><p>Hi</p></div>')).toBe(true);
  });

  it("doesn't take a template's own hyphenated class for the wrapper", () => {
    for (const cls of [
      'sr-email-body-wrapper',
      'my-sr-email-body',
      'email-body',
      'x sr-email-body-x',
    ]) {
      const html = `<div class="${cls}"><p>Hi</p></div>`;
      expect(isEmailBody(html)).toBe(false);
      expect(wrapEmailBody(html)).toBe(`<div class="sr-email-body">${html}</div>`);
    }
    expect(isEmailBody('<div data-class="sr-email-body"><p>Hi</p></div>')).toBe(false);
  });

  it('marks a lead standing in for the mail, even one cut from a wrapped body', () => {
    const lead = wrapEmailLead('<div class="sr-email-body"><p>The opening.</p>');
    expect(isEmailLead(lead)).toBe(true);
    expect(isEmailBody(lead)).toBe(true);
    expect(wrapEmailBody(lead)).toBe(lead);
    expect(wrapEmailLead(lead)).toBe(lead);
    expect(isEmailLead(sanitizeHtml(lead))).toBe(true);
    expect(isEmailLead(wrapEmailBody('<p>The whole mail.</p>'))).toBe(false);
  });

  it('leaves an empty body empty', () => {
    expect(wrapEmailBody('')).toBe('');
    expect(wrapEmailBody(null)).toBeNull();
  });
});

// The backend wraps newsletter bodies at ingest with its own copy of the
// wrapper and its detection regex; the two must agree byte for byte, or bodies
// get wrapped twice and leads go unrecognized.
describe('email-body wrapper parity with the backend', () => {
  const samples = [
    '<p>a</p>',
    '<div class="sr-email-body"><p>a</p></div>',
    " \n<div class='sr-email-body x'><p>a</p></div>",
    '﻿<div id="m" class=sr-email-body><p>a</p></div>',
    '<div class="sr-email-body-wrapper"><p>a</p></div>',
    '<div class="sr-email-body sr-email-lead"><p>lead</p></div>',
    '<section class="sr-email-body"><p>a</p></section>',
  ];

  it('uses the same class', () => {
    expect(backendEmailBody.EMAIL_BODY_CLASS).toBe(EMAIL_BODY_CLASS);
  });

  it.each(samples)('detects and wraps %j identically', (html) => {
    expect(backendEmailBody.isEmailBody(html)).toBe(isEmailBody(html));
    expect(backendEmailBody.wrapEmailBody(html)).toBe(wrapEmailBody(html));
  });
});
