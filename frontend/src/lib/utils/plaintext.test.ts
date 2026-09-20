// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { renderPlaintextBody } from './plaintext';
import { sanitizeHtml } from './sanitize';
import { getDisplayContent } from './displayItem';
import type { SocialDocument } from '$lib/types';

const URL = 'https://happyview.dev/blog/happyview-2.15';

function docItem(item: Partial<SocialDocument>) {
  const doc = {
    authorDid: 'did:plc:example',
    recordUri: 'at://did:plc:example/site.standard.document/3mvsjvh262k26',
    siteUri: 'at://did:plc:example/site.standard.publication/3mpokbucn3y26',
    title: 'HappyView v2.15',
    publishedAt: '2026-09-18T00:00:00.000Z',
    createdAt: '2026-09-18T00:00:00.000Z',
    ...item,
  } as SocialDocument;
  return { type: 'document', item: doc, key: doc.recordUri } as const;
}

describe('renderPlaintextBody', () => {
  it('turns blank-line-separated blocks into paragraphs', () => {
    expect(renderPlaintextBody('One.\n\nTwo.\n\nThree.')).toBe(
      '<p>One.</p><p>Two.</p><p>Three.</p>'
    );
  });

  it('keeps a single newline inside a block as a line break', () => {
    expect(renderPlaintextBody('Line one\nLine two')).toBe('<p>Line one<br>Line two</p>');
  });

  it('collapses runs of blank lines and ignores whitespace-only ones', () => {
    expect(renderPlaintextBody('One.\n\n\n  \n\nTwo.')).toBe('<p>One.</p><p>Two.</p>');
  });

  it('normalizes CRLF', () => {
    expect(renderPlaintextBody('One.\r\n\r\nTwo.')).toBe('<p>One.</p><p>Two.</p>');
  });

  it('returns empty for a whitespace-only body, so callers fall back', () => {
    expect(renderPlaintextBody('   \n\n  ')).toBe('');
  });

  // Escaping without decoding would newly show these raw: the old `{@html}`
  // render handed them to the browser, which decoded them.
  it('decodes entities the publisher encoded before escaping', () => {
    const el = document.createElement('div');
    el.innerHTML = renderPlaintextBody('Tom &amp; Jerry, and don&#8217;t forget &lt;b&gt;.');
    expect(el.textContent).toBe('Tom & Jerry, and don\u2019t forget <b>.');
    expect(el.querySelector('b')).toBeNull();
  });

  // The bug this exists for: angle brackets in prose were parsed as tags and then
  // deleted by the sanitizer, so the text silently lost characters on the way to
  // the reader. Assert the round trip, not just the escape.
  it('survives the sanitizer with its angle brackets intact', () => {
    const grammar = 'Full grammar: space:<spaceType>[?authority=<did>][&skey=<skey>]';
    const html = sanitizeHtml(renderPlaintextBody(grammar), URL);
    const el = document.createElement('div');
    el.innerHTML = html;
    expect(el.textContent).toBe(grammar);
  });

  it('does not let a body smuggle markup through the plaintext path', () => {
    const html = sanitizeHtml(
      renderPlaintextBody('<img src=x onerror=alert(1)> and <b>bold</b>'),
      URL
    );
    expect(html).not.toContain('<img');
    expect(html).not.toContain('<b>');
    const el = document.createElement('div');
    el.innerHTML = html;
    expect(el.textContent).toBe('<img src=x onerror=alert(1)> and <b>bold</b>');
  });
});

describe('getDisplayContent, document with no structured content', () => {
  it('renders textContent as plaintext instead of raw HTML', () => {
    const html = getDisplayContent(
      docItem({ textContent: "Intro.\n\nLet's talk about spaces\n\nBody.", description: 'Excerpt' })
    );
    // The apostrophe comes back as an entity (escapeHtml covers quotes too); it
    // renders as an apostrophe, so assert the text the reader actually shows.
    const el = document.createElement('div');
    el.innerHTML = html;
    expect(el.innerHTML).toBe("<p>Intro.</p><p>Let's talk about spaces</p><p>Body.</p>");
  });

  it('falls back to the description when textContent is blank', () => {
    expect(getDisplayContent(docItem({ textContent: '  \n ', description: 'Excerpt' }))).toBe(
      '<p>Excerpt</p>'
    );
  });

  // The description is what a stripped document shows until its body hydrates,
  // so it has to survive the sanitizer the same way the body does — otherwise
  // the card drops characters the body puts back a moment later.
  it('renders the description as plaintext too', () => {
    const html = sanitizeHtml(
      getDisplayContent(docItem({ description: 'space:<spaceType>[?authority=<did>]' })),
      URL
    );
    const el = document.createElement('div');
    el.innerHTML = html;
    expect(el.textContent).toBe('space:<spaceType>[?authority=<did>]');
  });

  it('returns empty when there is neither body nor description', () => {
    expect(getDisplayContent(docItem({}))).toBe('');
  });

  it('still prefers a recognized structured content body', () => {
    const html = getDisplayContent(
      docItem({
        content: { $type: 'at.markpub.markdown', text: { markdown: '# Heading' } },
        textContent: 'Heading',
      })
    );
    expect(html).toContain('<h1>Heading</h1>');
  });
});
