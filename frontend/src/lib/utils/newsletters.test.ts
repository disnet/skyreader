// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { isEmailBody, wrapEmailBody } from './newsletters';
import { sanitizeHtml } from './sanitize';

describe('wrapEmailBody', () => {
  it('wraps a body in the email-body scope', () => {
    expect(wrapEmailBody('<p>Hi</p>')).toBe('<div class="email-body"><p>Hi</p></div>');
  });

  it('is idempotent, including across a sanitize round-trip', () => {
    const once = sanitizeHtml(wrapEmailBody('<table><tr><td><h1>Hi</h1></td></tr></table>'));
    expect(wrapEmailBody(once)).toBe(once);
  });

  it('recognizes a wrapper however it was serialized', () => {
    const variants = [
      '\n  <div class="email-body"><p>Hi</p></div>',
      '\uFEFF<div class="email-body"><p>Hi</p></div>',
      "<div class='email-body'><p>Hi</p></div>",
      '<div data-x="1" class="reader email-body"><p>Hi</p></div>',
      '<DIV CLASS="email-body"><p>Hi</p></DIV>',
    ];
    for (const html of variants) {
      expect(isEmailBody(html)).toBe(true);
      expect(wrapEmailBody(html)).toBe(html);
    }
    expect(isEmailBody('<p>Hi</p><div class="email-body"></div>')).toBe(false);
    expect(isEmailBody('<div class="email-bodywork"><p>Hi</p></div>')).toBe(false);
  });

  it('leaves an empty body empty', () => {
    expect(wrapEmailBody('')).toBe('');
    expect(wrapEmailBody(null)).toBeNull();
  });
});
