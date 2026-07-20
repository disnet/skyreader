import { describe, expect, it } from 'bun:test';
import { restoreCollapsedMathML } from './app';

// Mirrors what LaTeXML (arXiv) ships: a display equation wrapped in an
// .ltx_equation container with full presentation MathML and a matching alttext.
const SOURCE = `
<div class="ltx_para">
  <table class="ltx_equation ltx_eqn_table">
    <math id="S1.E1.m1" class="ltx_Math" alttext="a^{2}+b^{2}=c^{2}" display="block" intent=":literal">
      <semantics><mrow><msup><mi>a</mi><mn>2</mn></msup><mo>+</mo><msup><mi>b</mi><mn>2</mn></msup></mrow>
      <annotation encoding="application/x-tex">a^{2}+b^{2}=c^{2}</annotation></semantics>
    </math>
  </table>
  <p>Inline <math alttext="x" display="inline"><semantics><mi>x</mi></semantics></math> stays.</p>
</div>`;

describe('restoreCollapsedMathML', () => {
  it('restores original presentation MathML for a Defuddle-collapsed display equation', () => {
    // What Defuddle leaves behind: data-latex set, presentation markup gone.
    const collapsed =
      '<math data-latex="a^{2}+b^{2}=c^{2}" display="block" xmlns="http://www.w3.org/1998/Math/MathML">a^{2}+b^{2}=c^{2}</math>';
    const out = restoreCollapsedMathML(SOURCE, collapsed);
    expect(out).toContain('<msup><mi>a</mi><mn>2</mn></msup>');
    // The restored element is the faithful source, keeping intent/class.
    expect(out).toContain('intent=":literal"');
    expect(out).not.toContain('data-latex="a^{2}+b^{2}=c^{2}"');
  });

  it('decodes entities when matching data-latex against source alttext', () => {
    const source =
      '<math alttext="a &lt; b" display="block"><semantics><mrow><mi>a</mi><mo>&lt;</mo><mi>b</mi></mrow></semantics></math>';
    const collapsed = '<math data-latex="a &lt; b" display="block">a &lt; b</math>';
    const out = restoreCollapsedMathML(source, collapsed);
    expect(out).toContain('<mo>&lt;</mo>');
  });

  it('leaves already-intact MathML untouched', () => {
    const intact = '<math data-latex="x" display="inline"><semantics><mi>x</mi></semantics></math>';
    expect(restoreCollapsedMathML(SOURCE, intact)).toBe(intact);
  });

  it('leaves a collapsed equation alone when the source has no match', () => {
    const collapsed = '<math data-latex="\\unknown{z}" display="block">\\unknown{z}</math>';
    expect(restoreCollapsedMathML(SOURCE, collapsed)).toBe(collapsed);
  });

  it('is a no-op for content with no math', () => {
    expect(restoreCollapsedMathML(SOURCE, '<p>no math</p>')).toBe('<p>no math</p>');
  });
});
