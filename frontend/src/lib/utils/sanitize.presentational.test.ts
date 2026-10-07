// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { sanitizeHtml } from './sanitize';

describe('sanitizeHtml presentational markup', () => {
  it('unwraps <font>/<big> but keeps their text', () => {
    const out = sanitizeHtml(
      '<p><font size="1" face="Arial" color="#999">Hello</font> <big>world</big></p>'
    );
    expect(out).toBe('<p>Hello world</p>');
  });

  it('drops email-template color and background attributes', () => {
    const out = sanitizeHtml(
      '<table bgcolor="#000" background="bg.png"><tbody><tr><td bgcolor="#111" align="center">x</td></tr></tbody></table>'
    );
    expect(out).not.toMatch(/bgcolor|background=/);
    expect(out).toContain('align="center"');
  });

  it('drops fixed layout widths from email tables but keeps image dimensions', () => {
    const out = sanitizeHtml(
      '<table width="600" height="100%"><tbody><tr height="20"><td width="560">x<img src="https://e.com/a.png" width="560" height="200"></td></tr></tbody></table>'
    );
    expect(out).toBe(
      '<table><tbody><tr><td>x<img src="https://e.com/a.png" width="560" height="200" loading="lazy" decoding="async"></td></tr></tbody></table>'
    );
  });

  it('keeps <small> and structural markup', () => {
    expect(sanitizeHtml('<p><small>caption</small></p>')).toBe('<p><small>caption</small></p>');
  });
});
