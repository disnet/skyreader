// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { wrapEmailBody } from './newsletters';
import { sanitizeHtml } from './sanitize';

describe('wrapEmailBody', () => {
  it('wraps a body in the email-body scope', () => {
    expect(wrapEmailBody('<p>Hi</p>')).toBe('<div class="email-body"><p>Hi</p></div>');
  });

  it('is idempotent, including across a sanitize round-trip', () => {
    const once = sanitizeHtml(wrapEmailBody('<table><tr><td><h1>Hi</h1></td></tr></table>'));
    expect(wrapEmailBody(once)).toBe(once);
  });

  it('leaves an empty body empty', () => {
    expect(wrapEmailBody('')).toBe('');
    expect(wrapEmailBody(null)).toBeNull();
  });
});
