import { describe, it, expect } from 'vitest';
import { cleanDiscussionNote } from './discussionNote';

const TITLE = 'Never Be Angry at Work';

describe('cleanDiscussionNote', () => {
  it('keeps a real note untouched', () => {
    expect(cleanDiscussionNote('Best take on this I have read all year.', TITLE)).toBe(
      'Best take on this I have read all year.'
    );
  });

  it('drops a bare URL post to nothing', () => {
    expect(
      cleanDiscussionNote('https://www.seangoedecke.com/you-should-never-be-angry/', TITLE)
    ).toBe(null);
  });

  it('drops a post that is only the article title', () => {
    expect(cleanDiscussionNote('Never be angry at work!', TITLE)).toBe(null);
  });

  it('strips the title and both links from a bridge post', () => {
    const bot =
      'Never Be Angry at Work https://www.seangoedecke.com/you-should-never-be-angry-at-work/ (https://news.ycombinator.com/item?id=49396811)';
    expect(cleanDiscussionNote(bot, TITLE)).toBe(null);
  });

  it('keeps the commentary a bot adds after the headline', () => {
    expect(cleanDiscussionNote('Never Be Angry at Work comments · 4 points', TITLE)).toBe(
      'comments · 4 points'
    );
  });

  it('strips a trailing headline too', () => {
    expect(cleanDiscussionNote('Worth reading: Never Be Angry at Work', TITLE)).toBe(
      'Worth reading'
    );
  });

  it('keeps a headline phrase woven into the end of a sentence', () => {
    const post =
      "Paul's article prompted a long one from me: What is the purpose of protocols?\n\nconnectedplaces.online/the-purpose-...";
    expect(cleanDiscussionNote(post, ['The Purpose of Protocols', 'Connected Places'])).toBe(
      "Paul's article prompted a long one from me: What is the purpose of protocols?"
    );
  });

  it('keeps a quoted headline that is the subject of the sentence', () => {
    expect(cleanDiscussionNote('“Never Be Angry at Work” changed my management style', TITLE)).toBe(
      '“Never Be Angry at Work” changed my management style'
    );
    expect(cleanDiscussionNote('"Never Be Angry at Work" is required reading', TITLE)).toBe(
      '"Never Be Angry at Work" is required reading'
    );
  });

  it('keeps a headline that ends in its own question mark mid-sentence', () => {
    expect(
      cleanDiscussionNote('What Is the Purpose of Protocols? asks Paul, and answers well', [
        'What Is the Purpose of Protocols?',
      ])
    ).toBe('What Is the Purpose of Protocols? asks Paul, and answers well');
  });

  it('still strips a quoted headline a bridge sets off with a dash', () => {
    expect(cleanDiscussionNote('“Never Be Angry at Work” — worth your time', TITLE)).toBe(
      'worth your time'
    );
  });

  it('lines up when the title punctuation splits differently', () => {
    expect(cleanDiscussionNote('A/B testing is underrated', 'A/B testing')).toBe(
      'A/B testing is underrated'
    );
    expect(cleanDiscussionNote('A/B testing: worth your time', 'A/B testing')).toBe(
      'worth your time'
    );
  });

  it('strips a headline set apart on its own line', () => {
    expect(cleanDiscussionNote('Never Be Angry at Work\nWorth your time', TITLE)).toBe(
      'Worth your time'
    );
  });

  it('leaves a quoted phrase alone when it is not the whole headline', () => {
    expect(cleanDiscussionNote('The bit about anger at work is the good part', TITLE)).toBe(
      'The bit about anger at work is the good part'
    );
  });

  it('does not strip a headline too short to be unmistakable', () => {
    expect(cleanDiscussionNote('Notes on the talk', 'Notes')).toBe('Notes on the talk');
  });

  it('strips a bare, truncated URL — what a Bluesky post actually stores', () => {
    expect(
      cleanDiscussionNote(
        'Some weekend thoughts on how LLMs change the way we start new projects. lucumr.pocoo.org/2026/8/22/fa...',
        TITLE
      )
    ).toBe('Some weekend thoughts on how LLMs change the way we start new projects.');
  });

  it('strips the publication name as well as the headline', () => {
    // The real case: a bridge leads with the FEED title, not the article's.
    expect(
      cleanDiscussionNote(
        "Armin Ronacher's Thoughts and Writings lucumr.pocoo.org/2026/8/22/fa... 的確有這種感覺",
        ['Fast and Hard Code', "Armin Ronacher's Thoughts and Writings"]
      )
    ).toBe('的確有這種感覺');
  });

  it('drops a note that is only the link label left over from a link drop', () => {
    expect(cleanDiscussionNote('Never Be Angry at Work Discussion', TITLE)).toBe(null);
    expect(cleanDiscussionNote('Comments', TITLE)).toBe(null);
    expect(cleanDiscussionNote('discussion: https://news.ycombinator.com/item?id=1', TITLE)).toBe(
      null
    );
  });

  it('drops a note left as bare punctuation once the link is gone', () => {
    expect(cleanDiscussionNote('Never Be Angry at Work ( https://example.com/a )', TITLE)).toBe(
      null
    );
  });

  it('leaves ordinary prose containing a dot alone', () => {
    expect(cleanDiscussionNote('I rewrote it in node.js and regretted it.', TITLE)).toBe(
      'I rewrote it in node.js and regretted it.'
    );
    expect(cleanDiscussionNote('Worth reading (etc.) if you have time', TITLE)).toBe(
      'Worth reading (etc.) if you have time'
    );
  });

  it('keeps a link label that is part of a real sentence', () => {
    expect(cleanDiscussionNote('The comments are better than the post', TITLE)).toBe(
      'The comments are better than the post'
    );
  });

  it('handles a missing note and a missing title', () => {
    expect(cleanDiscussionNote(null, TITLE)).toBe(null);
    expect(cleanDiscussionNote('   ', TITLE)).toBe(null);
    expect(cleanDiscussionNote('a plain thought', undefined)).toBe('a plain thought');
  });

  it('never exposes its internal title boundary marker', () => {
    const cleaned = cleanDiscussionNote(
      'Never Be Angry at Work\nA useful follow-up https://example.com/article',
      TITLE
    );
    expect(cleaned).toBe('A useful follow-up');
    expect(cleaned).not.toContain('\uE000');
  });
});
