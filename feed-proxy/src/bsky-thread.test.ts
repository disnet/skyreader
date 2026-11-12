import { describe, expect, it } from 'bun:test';
import {
  bskyPostUri,
  bskyThreadHtml,
  postTextHtml,
  threadTitle,
  type GetText,
  type PostView,
  type ThreadNode,
} from './bsky-thread';
import { siteSourceHtml } from './site-sources';
import { extractArticle } from './app';

const TVP = 'app.bsky.feed.defs#threadViewPost';
const ME = { did: 'did:plc:me', handle: 'me.example', displayName: 'Me Writer' };
const YOU = { did: 'did:plc:you', handle: 'you.example', displayName: 'You' };

function post(rkey: string, text: string, author = ME, extra: Partial<PostView> = {}): PostView {
  return {
    uri: `at://${author.did}/app.bsky.feed.post/${rkey}`,
    author,
    record: { text, createdAt: `2026-11-01T00:00:0${rkey.length % 10}Z` },
    indexedAt: '2026-11-01T00:00:00Z',
    ...extra,
  };
}

function node(p: PostView, rest: Partial<ThreadNode> = {}): ThreadNode {
  return { $type: TVP, post: p, replies: [], ...rest };
}

/** A GetText that answers getPostThread from a map of anchor at:// URI → thread. */
function appview(threads: Record<string, ThreadNode>, calls: string[] = []): GetText {
  return async (url) => {
    calls.push(url);
    const uri = new URL(url).searchParams.get('uri')!;
    const thread = threads[uri];
    return thread ? JSON.stringify({ thread }) : null;
  };
}

describe('bskyPostUri', () => {
  it('maps a post page to its at:// URI, by handle or DID', () => {
    expect(bskyPostUri(new URL('https://bsky.app/profile/me.example/post/3abc'))).toBe(
      'at://me.example/app.bsky.feed.post/3abc'
    );
    expect(bskyPostUri(new URL('https://bsky.app/profile/did:plc:me/post/3abc/'))).toBe(
      'at://did:plc:me/app.bsky.feed.post/3abc'
    );
  });

  it('leaves profiles, other sites and odd actors alone', () => {
    expect(bskyPostUri(new URL('https://bsky.app/profile/me.example'))).toBeNull();
    expect(bskyPostUri(new URL('https://example.com/profile/me.example/post/3abc'))).toBeNull();
    expect(bskyPostUri(new URL('https://bsky.app/profile/a%2Fb/post/3abc'))).toBeNull();
  });
});

describe('postTextHtml', () => {
  it('links facets by UTF-8 byte offset and breaks paragraphs on blank lines', () => {
    const text = 'héllo @you.example see example.com\n\nnext <line>\nsame para';
    const bytes = (s: string) => new TextEncoder().encode(s).length;
    const mentionStart = bytes('héllo ');
    const linkStart = bytes('héllo @you.example see ');
    const html = postTextHtml(text, [
      {
        index: { byteStart: mentionStart, byteEnd: mentionStart + bytes('@you.example') },
        features: [{ $type: 'app.bsky.richtext.facet#mention', did: 'did:plc:you' }],
      },
      {
        index: { byteStart: linkStart, byteEnd: linkStart + bytes('example.com') },
        features: [{ $type: 'app.bsky.richtext.facet#link', uri: 'https://example.com/full' }],
      },
    ]);
    expect(html).toBe(
      '<p>héllo <a href="https://bsky.app/profile/did:plc:you">@you.example</a> see <a href="https://example.com/full">example.com</a></p><p>next &lt;line&gt;<br>same para</p>'
    );
  });

  it('skips a facet whose index falls inside a character, and keeps a link in one paragraph', () => {
    expect(
      postTextHtml('🧵 see', [
        {
          index: { byteStart: 1, byteEnd: 4 },
          features: [{ $type: 'app.bsky.richtext.facet#link', uri: 'https://example.com' }],
        },
      ])
    ).toBe('<p>🧵 see</p>');
    expect(
      postTextHtml('a link\n\nhere', [
        {
          index: { byteStart: 2, byteEnd: 12 },
          features: [{ $type: 'app.bsky.richtext.facet#link', uri: 'https://example.com' }],
        },
      ])
    ).toBe('<p>a <a href="https://example.com/">link here</a></p>');
  });

  it('drops a link facet that is not http(s)', () => {
    const html = postTextHtml('click', [
      {
        index: { byteStart: 0, byteEnd: 5 },
        features: [{ $type: 'app.bsky.richtext.facet#link', uri: 'javascript:alert(1)' }],
      },
    ]);
    expect(html).toBe('<p>click</p>');
  });
});

describe('threadTitle', () => {
  it('is the first line, cut at a word', () => {
    expect(threadTitle('Short opener\nmore', ME)).toBe('Short opener');
    const long = 'word '.repeat(40);
    const title = threadTitle(long, ME);
    expect(title.length).toBeLessThanOrEqual(91);
    expect(title.endsWith('word…')).toBe(true);
    expect(threadTitle('', ME)).toBe('A thread by Me Writer');
    // Cut by code point: no half an emoji.
    expect(threadTitle('x'.repeat(89) + '😀😀', ME)).toBe('x'.repeat(89) + '😀…');
  });
});

describe('bskyThreadHtml', () => {
  it("reads the author's run in order from a post in the middle, leaving others' replies out", async () => {
    const one = post('1', 'First, the setup.');
    const two = post('22', 'Second, the turn.');
    const three = post('333', 'Third, the end.');
    const theirs = post('9', 'A reply from someone else', YOU);
    const later = post('4444', 'An aside I wrote later', ME, {
      record: { text: 'An aside I wrote later', createdAt: '2026-11-02T00:00:00Z' },
    });
    const anchor = node(two, {
      parent: node(one),
      replies: [node(theirs), node(later), node(three)],
    });
    const doc = (await bskyThreadHtml(
      'https://bsky.app/profile/me.example/post/22',
      appview({ 'at://me.example/app.bsky.feed.post/22': anchor })
    ))!;
    const html = doc.html;
    expect(doc.title).toBe('First, the setup.');
    // Kept out of the <head>, where Defuddle would strip the opening that matches it.
    expect(html).not.toContain('<title>');
    expect(html).toContain('<meta name="author" content="Me Writer">');
    const body = html.slice(html.indexOf('<article>'));
    expect(body.indexOf('First')).toBeLessThan(body.indexOf('Second'));
    expect(body.indexOf('Second')).toBeLessThan(body.indexOf('Third'));
    expect(body).not.toContain('someone else');
    // The earlier of two self-replies continues the run.
    expect(body).not.toContain('aside');
  });

  it('keeps images, quotes and link cards', async () => {
    const p = post('1', 'Look', ME, {
      embed: {
        $type: 'app.bsky.embed.recordWithMedia#view',
        media: {
          $type: 'app.bsky.embed.images#view',
          images: [{ fullsize: 'https://cdn.bsky.app/img/full/x', alt: 'A "chart"' }],
        },
        record: {
          record: {
            $type: 'app.bsky.embed.record#viewRecord',
            uri: 'at://did:plc:you/app.bsky.feed.post/3q',
            author: YOU,
            value: { text: 'Quoted words' },
          },
        },
      },
    });
    const q = post('22', 'And', ME, {
      embed: {
        $type: 'app.bsky.embed.external#view',
        external: { uri: 'https://example.com/a', title: 'An article' },
      },
    });
    const doc = (await bskyThreadHtml(
      'https://bsky.app/profile/did:plc:me/post/1',
      appview({ 'at://did:plc:me/app.bsky.feed.post/1': node(p, { replies: [node(q)] }) })
    ))!;
    const html = doc.html;
    expect(html).toContain(
      '<figure><img src="https://cdn.bsky.app/img/full/x" alt="A &quot;chart&quot;"></figure>'
    );
    expect(doc.image).toBe('https://cdn.bsky.app/img/full/x');
    expect(html).not.toContain('og:image');
    expect(html).toContain('<blockquote><p>Quoted words</p>');
    expect(html).toContain('href="https://bsky.app/profile/did:plc:you/post/3q"');
    expect(html).toContain('<a href="https://example.com/a">An article</a>');
  });

  it('says who a run replies to when it starts as a reply to someone else', async () => {
    const anchor = node(post('1', 'My answer'), { parent: node(post('0', 'Question?', YOU)) });
    const doc = (await bskyThreadHtml(
      'https://bsky.app/profile/me.example/post/1',
      appview({ 'at://me.example/app.bsky.feed.post/1': anchor })
    ))!;
    const html = doc.html;
    expect(html).toContain(
      'Replying to <a href="https://bsky.app/profile/did:plc:you">@you.example</a>'
    );
    expect(html).not.toContain('Question?');
  });

  it('continues a run cut off by the request depth', async () => {
    const calls: string[] = [];
    // The first answer stops at post 2 with its replies unloaded.
    const cut = { $type: TVP, post: post('22', 'two', ME, { replyCount: 1 }) };
    const first = node(post('1', 'one'), { replies: [cut] });
    const cont = node(post('22', 'two', ME, { replyCount: 1 }), {
      replies: [node(post('333', 'three'))],
    });
    const doc = (await bskyThreadHtml(
      'https://bsky.app/profile/me.example/post/1',
      appview(
        {
          'at://me.example/app.bsky.feed.post/1': first,
          'at://did:plc:me/app.bsky.feed.post/22': cont,
        },
        calls
      )
    ))!;
    const html = doc.html;
    expect(calls).toHaveLength(2);
    expect(html).toContain('<p>one</p><p>two</p><p>three</p>');
  });

  it('keeps what was read when a continuation fails', async () => {
    let calls = 0;
    const cut = { $type: TVP, post: post('22', 'two', ME, { replyCount: 1 }) };
    const first = node(post('1', 'one'), { replies: [cut] });
    const get: GetText = async () => {
      if (calls++ === 0) return JSON.stringify({ thread: first });
      throw new Error('timed out');
    };
    const doc = await bskyThreadHtml('https://bsky.app/profile/me.example/post/1', get);
    expect(doc?.html).toContain('<p>one</p><p>two</p>');
  });

  it('survives the extractor whole: the opening post and the first picture', async () => {
    const img = (n: number) => ({
      $type: 'app.bsky.embed.images#view',
      images: [{ fullsize: `https://cdn.bsky.app/img/full/${n}`, alt: '' }],
    });
    const opener = 'How we rebuilt our search index, a thread';
    const posts = Array.from({ length: 9 }, (_, i) =>
      post(
        String(i + 1).repeat(i + 1),
        i === 0 ? opener : `Part ${i + 1} goes on about the index for a while, in some detail.`,
        ME,
        { embed: i < 3 ? img(i) : undefined }
      )
    );
    let tree: ThreadNode = node(posts[8]);
    for (let i = 7; i >= 0; i--) tree = node(posts[i], { replies: [tree] });
    const doc = (await bskyThreadHtml(
      'https://bsky.app/profile/me.example/post/1',
      appview({ 'at://me.example/app.bsky.feed.post/1': tree })
    ))!;
    const extracted = await extractArticle(doc.html, 'https://bsky.app/profile/me.example/post/1');
    expect(extracted.content).toContain(opener);
    for (const n of [0, 1, 2]) expect(extracted.content).toContain(`img/full/${n}`);
  });

  it('holds nothing for an author hidden from signed-out readers, or a missing post', async () => {
    const hidden = { ...ME, labels: [{ val: '!no-unauthenticated' }] };
    expect(
      await bskyThreadHtml(
        'https://bsky.app/profile/me.example/post/1',
        appview({ 'at://me.example/app.bsky.feed.post/1': node(post('1', 'hi', hidden)) })
      )
    ).toBeNull();
    expect(
      await bskyThreadHtml(
        'https://bsky.app/profile/me.example/post/1',
        appview({
          'at://me.example/app.bsky.feed.post/1': {
            $type: 'app.bsky.feed.defs#notFoundPost',
          } as ThreadNode,
        })
      )
    ).toBeNull();
    expect(
      await bskyThreadHtml('https://bsky.app/profile/me.example/post/1', appview({}))
    ).toBeNull();
  });

  it('keeps a quoted author hidden from signed-out readers to a link', async () => {
    const p = post('1', 'Look', ME, {
      embed: {
        $type: 'app.bsky.embed.record#view',
        record: {
          $type: 'app.bsky.embed.record#viewRecord',
          uri: 'at://did:plc:you/app.bsky.feed.post/3q',
          author: { ...YOU, labels: [{ val: '!no-unauthenticated' }] },
          value: { text: 'Private-ish words' },
        },
      },
    });
    const doc = (await bskyThreadHtml(
      'https://bsky.app/profile/me.example/post/1',
      appview({ 'at://me.example/app.bsky.feed.post/1': node(p) })
    ))!;
    const html = doc.html;
    expect(html).not.toContain('Private-ish');
    expect(html).toContain('href="https://bsky.app/profile/did:plc:you/post/3q"');
  });

  it('is reached through siteSourceHtml', async () => {
    const html = await siteSourceHtml(
      'https://bsky.app/profile/me.example/post/1',
      appview({ 'at://me.example/app.bsky.feed.post/1': node(post('1', 'hello')) })
    );
    expect(html?.html).toContain('<p>hello</p>');
    expect(await siteSourceHtml('https://example.com/', appview({}))).toBeNull();
  });
});
