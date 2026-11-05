import { describe, it, expect } from 'vitest';
import {
  channelLabelOptions,
  coerceChannelLabelFilter,
  coerceContentLabelPreferences,
  contentLabelName,
  contentLabelPreference,
  contentLabelVerdict,
  matchesChannelLabelFilter,
  shownByContentLabels,
} from './contentLabels';

describe('contentLabelName', () => {
  it('names known labels and passes others through', () => {
    expect(contentLabelName('ai-generated')).toBe('Made with AI');
    expect(contentLabelName('gore')).toBe('Graphic media');
    expect(contentLabelName('spoilers')).toBe('spoilers');
  });
});

describe('contentLabelPreference', () => {
  it('uses defaults: AI shows, adult labels warn, unknown labels show', () => {
    expect(contentLabelPreference('ai-generated', {})).toBe('show');
    expect(contentLabelPreference('sexual', {})).toBe('warn');
    expect(contentLabelPreference('spoilers', {})).toBe('show');
  });

  it('reads the reader setting, and an alias reads its parent', () => {
    expect(contentLabelPreference('ai-generated', { 'ai-generated': 'hide' })).toBe('hide');
    expect(contentLabelPreference('gore', { 'graphic-media': 'show' })).toBe('show');
  });
});

describe('coerceContentLabelPreferences', () => {
  it('keeps only valid settings for configurable labels', () => {
    expect(
      coerceContentLabelPreferences({
        'ai-generated': 'hide',
        sexual: 'nope',
        gore: 'hide',
        spoilers: 'hide',
      })
    ).toEqual({ 'ai-generated': 'hide' });
    expect(coerceContentLabelPreferences('junk')).toEqual({});
  });
});

describe('contentLabelVerdict', () => {
  it('hides when any label is hidden, else warns on the first warned label', () => {
    expect(contentLabelVerdict(undefined, {})).toEqual({ hidden: false, warn: null });
    expect(contentLabelVerdict(['ai-generated'], {})).toEqual({ hidden: false, warn: null });
    expect(contentLabelVerdict(['ai-generated', 'nudity'], {})).toEqual({
      hidden: false,
      warn: 'nudity',
    });
    expect(contentLabelVerdict(['nudity', 'ai-generated'], { 'ai-generated': 'hide' })).toEqual({
      hidden: true,
      warn: 'nudity',
    });
    // A hidden label shown anyway (a channel keeping only it) still gates the body.
    expect(contentLabelVerdict(['ai-generated'], { 'ai-generated': 'hide' })).toEqual({
      hidden: true,
      warn: 'ai-generated',
    });
  });
});

describe('channel label filters', () => {
  it('coerces only well-formed, non-empty filters', () => {
    expect(
      coerceChannelLabelFilter({ mode: 'exclude', labels: ['ai-generated', 'ai-generated'] })
    ).toEqual({
      mode: 'exclude',
      labels: ['ai-generated'],
    });
    expect(coerceChannelLabelFilter({ mode: 'exclude', labels: [] })).toBeUndefined();
    expect(coerceChannelLabelFilter({ mode: 'other', labels: ['x'] })).toBeUndefined();
    expect(coerceChannelLabelFilter(undefined)).toBeUndefined();
  });

  it('exclude drops labeled items; include keeps only them', () => {
    const exclude = { mode: 'exclude' as const, labels: ['ai-generated'] };
    const include = { mode: 'include' as const, labels: ['ai-generated'] };
    expect(matchesChannelLabelFilter(['ai-generated'], exclude)).toBe(false);
    expect(matchesChannelLabelFilter(undefined, exclude)).toBe(true);
    expect(matchesChannelLabelFilter(['ai-generated'], include)).toBe(true);
    expect(matchesChannelLabelFilter(undefined, include)).toBe(false);
    expect(matchesChannelLabelFilter(undefined, undefined)).toBe(true);
  });

  it('matches an alias by the label it shares a setting with', () => {
    expect(
      matchesChannelLabelFilter(['gore'], { mode: 'include', labels: ['graphic-media'] })
    ).toBe(true);
  });
});

describe('shownByContentLabels', () => {
  const hideAi = { 'ai-generated': 'hide' as const };

  it('leaves out a label hidden in settings', () => {
    expect(shownByContentLabels(['ai-generated'], hideAi)).toBe(false);
    expect(shownByContentLabels(['sexual'], {})).toBe(true);
    expect(shownByContentLabels(undefined, hideAi)).toBe(true);
  });

  it('shows a hidden label in a channel that keeps only it', () => {
    const only = { mode: 'include' as const, labels: ['ai-generated'] };
    expect(shownByContentLabels(['ai-generated'], hideAi, only)).toBe(true);
    // ...but not another hidden label the post also carries.
    expect(shownByContentLabels(['ai-generated', 'porn'], { ...hideAi, porn: 'hide' }, only)).toBe(
      false
    );
  });

  it('applies the channel rule on top', () => {
    const out = { mode: 'exclude' as const, labels: ['sexual'] };
    expect(shownByContentLabels(['sexual'], {}, out)).toBe(false);
    expect(shownByContentLabels(['ai-generated'], {}, out)).toBe(true);
  });
});

describe('channelLabelOptions', () => {
  it('offers the configurable labels, then other labels seen, sorted', () => {
    const options = channelLabelOptions([['zines', 'ai-generated'], undefined, ['gore', 'art']]);
    const values = options.map((o) => o.value);
    expect(values.slice(0, 5)).toEqual([
      'ai-generated',
      'porn',
      'sexual',
      'nudity',
      'graphic-media',
    ]);
    expect(values.slice(5)).toEqual(['art', 'zines']);
  });
});
