// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { sanitizeHtml } from './sanitize';

describe('sanitizeHtml MathML', () => {
  it('keeps presentation markup intact', () => {
    const out = sanitizeHtml('<math display="block"><mfrac><mn>1</mn><mn>2</mn></mfrac></math>');
    expect(out).toContain('<mfrac>');
    expect(out).toContain('display="block"');
  });

  it('keeps the Temml output generated for TeX-only feed summaries', () => {
    const out = sanitizeHtml(
      '<math xmlns="http://www.w3.org/1998/Math/MathML"><mrow><mn>10.09</mn><mo>×</mo>' +
        '<msup><mn>10</mn><mn>9</mn></msup></mrow></math>'
    );
    expect(out).toContain('<mn>10.09</mn><mo>×</mo>');
    expect(out).toContain('<msup><mn>10</mn><mn>9</mn></msup>');
  });

  it('keeps the structural elements publishers actually emit', () => {
    const out = sanitizeHtml(
      '<math><mtable><mtr><mtd><msup><mi>x</mi><mn>2</mn></msup></mtd></mtr></mtable>' +
        '<mover accent="true"><mi>y</mi><mo>^</mo></mover><mspace width="1em"></mspace></math>'
    );
    for (const tag of ['mtable', 'mtr', 'mtd', 'msup', 'mover', 'mspace']) {
      expect(out).toContain(`<${tag}`);
    }
    expect(out).toContain('accent="true"');
  });

  it('keeps alttext and intent on <math> for accessibility', () => {
    const out = sanitizeHtml('<math alttext="a squared" intent=":literal"><mi>a</mi></math>');
    expect(out).toContain('alttext="a squared"');
    expect(out).toContain('intent=":literal"');
  });

  it('preserves <mtable> alignment attributes for multi-line equations', () => {
    // LaTeXML/MathJax emit columnalign/columnspacing on every aligned equation,
    // matrix, and cases block. DOMPurify's default allowlist drops them (it
    // ships a legacy "columnsalign" no engine emits), which collapses aligned
    // equations to centered — so we add them back explicitly.
    const out = sanitizeHtml(
      '<math display="block"><mtable columnalign="right left" columnspacing="0.5em" rowspacing="0.2em">' +
        '<mtr><mtd><mi>x</mi></mtd><mtd><mo>=</mo><mn>1</mn></mtd></mtr></mtable></math>'
    );
    expect(out).toContain('columnalign="right left"');
    expect(out).toContain('columnspacing="0.5em"');
    expect(out).toContain('rowspacing="0.2em"');
  });

  it('drops the TeX <annotation> instead of leaking its source as text', () => {
    // What MathJax and LaTeXML (arXiv) ship for every equation. Unwrapping
    // <semantics> without removing the annotation would print "a^2+b^2"
    // verbatim next to the rendered equation.
    const out = sanitizeHtml(
      '<math display="block"><semantics><mrow><msup><mi>a</mi><mn>2</mn></msup></mrow>' +
        '<annotation encoding="application/x-tex">a^2+b^2</annotation></semantics></math>'
    );
    expect(out).toContain('<semantics>');
    expect(out).toContain('<msup>');
    expect(out).not.toContain('a^2+b^2');
    expect(out).not.toContain('annotation');
  });

  it('drops <annotation-xml> and everything inside it (mXSS vector)', () => {
    const out = sanitizeHtml(
      '<math><semantics><mi>x</mi><annotation-xml encoding="text/html">' +
        '<img src=x onerror=alert(1)><iframe src="https://evil.com"></iframe>' +
        '</annotation-xml></semantics></math>'
    );
    expect(out).toContain('<mi>x</mi>');
    expect(out).not.toContain('annotation');
    expect(out).not.toContain('onerror');
    expect(out).not.toContain('evil.com');
  });

  it('still strips scripts and styles around math', () => {
    const out = sanitizeHtml(
      '<script type="math/tex">x^2</script><math style="position:fixed"><mi>x</mi></math>'
    );
    expect(out).not.toContain('script');
    expect(out).not.toContain('position:fixed');
    expect(out).toContain('<mi>x</mi>');
  });

  it('leaves the hook state clean for subsequent calls', () => {
    sanitizeHtml('<math><semantics><mi>x</mi><annotation>tex</annotation></semantics></math>');
    const out = sanitizeHtml('<p>plain <b>text</b></p>');
    expect(out).toBe('<p>plain <b>text</b></p>');
  });
});
