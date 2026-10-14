import { describe, expect, it } from 'vitest';
import {
  buildPdfTextModel,
  locateInPdf,
  selectorForSpan,
  slicesForSpan,
  textOffsetAt,
  type PdfTextRun,
} from './pdfTextModel';

const run = (str: string, hasEOL = false, transform?: number[]): PdfTextRun => ({
  str,
  hasEOL,
  transform,
});

describe('buildPdfTextModel', () => {
  it('joins lines with a space and pages likewise', () => {
    const model = buildPdfTextModel([
      [run('The first line', true), run('and the second.', true)],
      [run('Next page.')],
    ]);
    expect(model.text).toBe('The first line and the second. Next page.');
  });

  it('collapses whitespace and runs of space items', () => {
    const model = buildPdfTextModel([[run('Two  words'), run(' '), run(' and'), run('   more ')]]);
    expect(model.text).toBe('Two words and more');
  });

  it("drops a line-end hyphen before a lowercase continuation, like the extractor's joinLine", () => {
    const model = buildPdfTextModel([[run('an inter-', true), run('national treaty')]]);
    expect(model.text).toBe('an international treaty');
  });

  it('keeps a hyphen before a capital', () => {
    const model = buildPdfTextModel([[run('Jean-', true), run('Paul Sartre')]]);
    expect(model.text).toBe('Jean- Paul Sartre');
  });

  it('leaves rotated runs out', () => {
    const model = buildPdfTextModel([
      [
        run('arXiv:2401.00001', true, [0, 10, -10, 0, 20, 300]),
        run('Body text.', false, [10, 0, 0, 10, 72, 700]),
      ],
    ]);
    expect(model.text).toBe('Body text.');
  });

  it("maps every character to its place in the text, and a dropped one to the next's", () => {
    const model = buildPdfTextModel([[run('inter-', true), run('national')]]);
    expect(textOffsetAt(model, 0, 0, 0)).toBe(0);
    // The hyphen takes no room: it starts where "n" of "national" does.
    expect(textOffsetAt(model, 0, 0, 5)).toBe(5);
    expect(textOffsetAt(model, 0, 1, 0)).toBe(5);
    expect(textOffsetAt(model, 0, 1, 8)).toBe(model.text.length);
  });
});

describe('selectors over the model', () => {
  const pages = [
    [run('Attention is all you need.', true), run('We propose a new simple net-', true)],
    [run('work architecture, the Transformer.')],
  ];

  it('makes a selector for a selection, trimmed, with context', () => {
    const model = buildPdfTextModel(pages);
    // From the space before "We" (trimmed off) to the comma.
    const start = model.text.indexOf(' We');
    const end = model.text.indexOf(',');
    const selector = selectorForSpan(model, start, end);
    expect(selector?.exact).toBe('We propose a new simple network architecture');
    expect(selector?.prefix).toBe('Attention is all you need. ');
    expect(selector?.suffix?.startsWith(', the Transformer')).toBe(true);
  });

  it('returns null for a span of nothing but space', () => {
    const model = buildPdfTextModel(pages);
    const at = model.text.indexOf(' ');
    expect(selectorForSpan(model, at, at + 1)).toBeNull();
  });

  it('locates a highlight made in the reflowed text across a page break and a broken word', () => {
    const model = buildPdfTextModel(pages);
    // What the extractor's reflow reads, so what a text-view highlight stores.
    const slices = locateInPdf(model, {
      type: 'TextQuoteSelector',
      exact: 'simple network architecture',
    });
    expect(slices).toEqual([
      { page: 0, run: 1, from: 17, to: 28 },
      { page: 1, run: 0, from: 0, to: 17 },
    ]);
  });

  it("finds a quote whose spacing differs from the model's", () => {
    const model = buildPdfTextModel([[run('two'), run('columns of text')]]);
    expect(model.text).toBe('twocolumns of text');
    const slices = locateInPdf(model, { type: 'TextQuoteSelector', exact: 'two columns' });
    expect(slices).toEqual([
      { page: 0, run: 0, from: 0, to: 3 },
      { page: 0, run: 1, from: 0, to: 7 },
    ]);
  });

  it('uses context to choose between repeats', () => {
    const model = buildPdfTextModel([[run('the cat sat. the dog ran. the cat ran.')]]);
    const slices = locateInPdf(model, {
      type: 'TextQuoteSelector',
      exact: 'the cat',
      prefix: 'the dog ran. ',
    });
    expect(slices).toEqual([{ page: 0, run: 0, from: 26, to: 33 }]);
  });

  it('is null for a quote the PDF does not contain', () => {
    const model = buildPdfTextModel(pages);
    expect(locateInPdf(model, { type: 'TextQuoteSelector', exact: 'not in here' })).toBeNull();
  });

  it('round-trips: a selector made on the pages locates the same runs', () => {
    const model = buildPdfTextModel(pages);
    const start = textOffsetAt(model, 0, 1, 3);
    const end = textOffsetAt(model, 1, 0, 4);
    const selector = selectorForSpan(model, start, end)!;
    expect(selector.exact).toBe('propose a new simple network');
    expect(locateInPdf(model, selector)).toEqual(slicesForSpan(model, start, end));
  });
});

describe('offsets across a joined hyphen and rotated runs', () => {
  it('keeps a run end at the next run start when the hyphen is dropped', () => {
    const model = buildPdfTextModel([[run('inter-', true), run('national')]]);
    expect(model.text).toBe('international');
    expect(model.offsets[0][0][6]).toBe(5);
    expect(model.offsets[0][1][0]).toBe(5);
  });

  it('leaves a rotated run out of the slices', () => {
    const stamp = { str: 'arXiv', transform: [0, 1, -1, 0, 0, 0] };
    const model = buildPdfTextModel([[run('one '), stamp, run('two')]]);
    expect(slicesForSpan(model, 0, model.text.length).some((s) => s.run === 1)).toBe(false);
  });
});
