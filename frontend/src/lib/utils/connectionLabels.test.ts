import { describe, it, expect } from 'vitest';
import { connectionTargetLabel, connectionTypeLabel } from './connectionLabels';

describe('connectionTargetLabel', () => {
  it('reads a wordy slug as the title', () => {
    expect(connectionTargetLabel('https://www.example.com/2026/10/why-reading-adds-up/')).toBe(
      'example.com · why reading adds up'
    );
    expect(connectionTargetLabel('https://example.com/posts/notes_on_attention.html')).toBe(
      'example.com · notes on attention'
    );
  });

  it('falls back to the site for ids and bare paths', () => {
    expect(connectionTargetLabel('https://example.com/p/8f3a9c21')).toBe('example.com');
    expect(connectionTargetLabel('https://example.com/')).toBe('example.com');
    expect(connectionTargetLabel('https://arxiv.org/abs/2401.01234')).toBe('arxiv.org');
  });

  it('leaves something that is not a URL alone', () => {
    expect(connectionTargetLabel('not a url')).toBe('not a url');
  });
});

describe('connectionTypeLabel', () => {
  it('lowercases Semble’s types', () => {
    expect(connectionTypeLabel('LEADS_TO')).toBe('leads to');
    expect(connectionTypeLabel('SUPPORTS')).toBe('supports');
    expect(connectionTypeLabel(null)).toBe(null);
  });
});
