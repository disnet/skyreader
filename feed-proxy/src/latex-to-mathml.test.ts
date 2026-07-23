import { describe, expect, it } from 'bun:test';
import { convertLatexToMathML } from './latex-to-mathml';

describe('convertLatexToMathML', () => {
  it('renders the inline TeX emitted by arXiv RSS descriptions', () => {
    const out = convertLatexToMathML('Using $10.09\\times10^{9}$ $J/\\psi$ events at BESIII.');

    expect(out).toContain('<mn>10.09</mn><mo>×</mo><msup><mn>10</mn>');
    expect(out).toContain('<mi>J</mi><mi>/</mi><mi>ψ</mi>');
    expect(out).not.toContain('$10.09');
    expect(out).not.toContain('$J/');
  });

  it('renders display and parenthesized TeX delimiters', () => {
    const out = convertLatexToMathML('Inline \\(x^2\\). Display: $$a+b=c$$');

    expect(out).toContain('<msup><mi>x</mi>');
    expect(out).toContain('display="block"');
    expect(out).toContain('<mi>a</mi><mo>+</mo><mi>b</mi><mo>=</mo><mi>c</mi>');
  });

  it('does not mistake a currency range for math', () => {
    expect(convertLatexToMathML('Tickets cost $5 to $10 each.')).toBe(
      'Tickets cost $5 to $10 each.'
    );
  });

  it('leaves escaped dollars, code, and existing MathML alone', () => {
    const input = 'Pay \\$5. <code>$x^2$</code> <math><msup><mi>y</mi><mn>2</mn></msup></math>';
    expect(convertLatexToMathML(input)).toBe(input);
  });

  it('preserves unsupported TeX instead of failing the feed', () => {
    expect(convertLatexToMathML('Before $\\notARealMacro{x}$ after')).toBe(
      'Before $\\notARealMacro{x}$ after'
    );
  });

  it('converts math in HTML text nodes without touching attributes', () => {
    const out = convertLatexToMathML('<p title="$not-math$">Value: $x_1$.</p>');

    expect(out).toContain('title="$not-math$"');
    expect(out).toContain('<msub><mi>x</mi><mn>1</mn></msub>');
  });
});
