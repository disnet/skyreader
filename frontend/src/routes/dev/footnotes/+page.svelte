<script lang="ts">
  // Harness for footnotes in a saved web article: the real SavedReader over a
  // body shaped the way the extractor (Defuddle) hands footnotes over — `#fn:1`
  // markers and a notes list at the end — plus a Substack-style note written out
  // against the article's own address, a note citing another note, and a link to
  // a heading. A marker opens its note beside it; the heading link still jumps.
  // Switch to Pages in the reader's style menu to try paged mode.
  import SavedReader from '$lib/components/feed/SavedReader.svelte';
  import type { FeedDisplayItem } from '$lib/stores/feedView.svelte';

  const URL = 'https://example.com/2026/margins';
  const filler = [
    'Books used to argue with themselves at the bottom of the page. A claim in the text, a qualification underneath, and the reader’s eye dropping down and coming back up without ever losing the line.',
    'The web flattened that. A footnote became a number that throws you to the end of a long page, where you read the note, hunt for the little return arrow, and try to remember which sentence you were in.',
    'Nothing about the note changed. Only the distance between it and the sentence it belongs to, and with the distance, the habit of reading it at all.',
  ];
  const para = (i: number) => `<p>${filler[i % filler.length]}</p>`;
  const content = `
    <p>Footnotes are an old technology for keeping an aside close to the sentence that needs it.<sup id="fnref:1"><a href="#fn:1">1</a></sup> Sidenotes put them in the margin instead.<sup id="fnref:2"><a href="#fn:2">2</a></sup></p>
    ${para(0)}${para(1)}
    <p>Newsletters write their notes out in full, against the post’s own address.<a class="footnote-anchor" id="footnote-anchor-3" href="${URL}#footnote-3">3</a> The rest of this piece is about <a href="#later">what happens later</a>.</p>
    ${para(2)}${para(0)}${para(1)}${para(2)}
    <h2 id="later">Later</h2>
    ${para(0)}${para(1)}${para(2)}${para(0)}${para(1)}${para(2)}${para(0)}${para(1)}
    <hr>
    <div id="footnotes"><ol>
      <li id="fn:1"><p>Bringhurst calls them “the reader’s permission to wander.” See also note <a href="#fn:2">2</a>, and <a href="https://en.wikipedia.org/wiki/Note_(typography)">the history of the form</a>. <a class="footnote-backref" href="#fnref:1">↩</a></p></li>
      <li id="fn:2"><p>Edward Tufte’s books are the usual example; his margins carry as much as the text. <a class="footnote-backref" href="#fnref:2">↩</a></p></li>
    </ol></div>
    <div class="footnote"><a id="footnote-3" href="${URL}#footnote-anchor-3" class="footnote-number">3</a><div class="footnote-content"><p>Substack’s markup puts the number first and the note after it, both inside one block.</p></div></div>`;

  const KEY = 'at://did:plc:devharness/app.skyreader.feed.saved/footnotes';
  const readerItem = {
    type: 'saved',
    key: KEY,
    item: {
      rkey: 'footnotes',
      uri: KEY,
      url: URL,
      title: 'Notes in the margin',
      author: 'A. Writer',
      description: 'Generated for the footnotes harness.',
      content,
      domain: 'example.com',
      image: null,
      wordCount: 900,
      publishedAt: '2026-09-01T12:00:00Z',
      savedAt: '2026-09-20T12:00:00Z',
    },
  } as unknown as FeedDisplayItem;
</script>

<SavedReader {readerItem} onClose={() => {}} />
