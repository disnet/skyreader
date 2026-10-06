// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { isEmailBody, isEmailLead, wrapEmailBody, wrapEmailLead } from './newsletters';
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
