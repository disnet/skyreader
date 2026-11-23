import { describe, expect, it } from 'vitest';
import { quoteOrder, quoteRows, type QuoteCandidate } from './quotePicker';

const c = (text: string, note = ''): QuoteCandidate => ({ text, note });
const all = [
  c('Alpha one.'),
  c('Beta two.', 'about libraries'),
  c('Gamma three.'),
  c('Delta four.'),
];
const texts = (rows: QuoteCandidate[]) => rows.map((r) => r.text);

describe('quoteOrder', () => {
  it('puts what is chosen first, in post order, then the rest as offered', () => {
    expect(quoteOrder(all, ['Gamma three.', 'Alpha one.'])).toEqual([
      'Gamma three.',
      'Alpha one.',
      'Beta two.',
      'Delta four.',
    ]);
  });

  it('leaves out a chosen passage that is no longer offered', () => {
    expect(quoteOrder(all.slice(0, 2), ['Gone.', 'Beta two.'])).toEqual([
      'Beta two.',
      'Alpha one.',
    ]);
  });
});

describe('quoteRows', () => {
  it('keeps the snapshot order, so a fresh tick does not move its row', () => {
    const order = quoteOrder(all, []);
    expect(texts(quoteRows(all, ['Delta four.'], order, ''))).toEqual(texts(all));
  });

  it('appends highlights that arrived after the snapshot', () => {
    const order = quoteOrder(all.slice(0, 2), []);
    expect(texts(quoteRows(all, [], order, ''))).toEqual(texts(all));
  });

  it('matches every word, in the passage or the note, case-blind', () => {
    const order = quoteOrder(all, []);
    expect(texts(quoteRows(all, [], order, 'LIBRARIES'))).toEqual(['Beta two.']);
    expect(texts(quoteRows(all, [], order, 'two libraries'))).toEqual(['Beta two.']);
    expect(texts(quoteRows(all, [], order, 'one two'))).toEqual([]);
  });

  it('always shows what is chosen, so it can be taken out under any filter', () => {
    const order = quoteOrder(all, ['Gamma three.']);
    expect(texts(quoteRows(all, ['Gamma three.'], order, 'alpha'))).toEqual([
      'Gamma three.',
      'Alpha one.',
    ]);
  });
});
