// jsdom, for DOMParser.
import { describe, it, expect } from 'vitest';
import { articleLinks, linkTitleHint } from './articleLinks';

const ARTICLE = 'https://essays.example/how-cities-remember';

function parse(html: string) {
  return new DOMParser().parseFromString(html, 'text/html');
}

describe('articleLinks', () => {
  it('lists each web page once, in order, with its words', () => {
    const doc = parse(`
      <p>See <a href="https://maps.example/streets">the   old
        streets</a> and <a href="/plaques">plaques</a>.</p>
      <p><a href="https://maps.example/streets/?utm_source=x">again</a></p>
      <p><a href="https://img.example/x"><img src="x.png"></a>
         <a href="https://img.example/x">a picture</a></p>
      <p><a href="/uploads/photo.JPG"><img src="t.jpg"></a>
         <a href="https://files.example/a.zip">zip</a>
         <a href="https://papers.example/paper.pdf">a paper</a></p>`);
    expect(articleLinks(doc, ARTICLE)).toEqual([
      { url: 'https://maps.example/streets', text: 'the old streets' },
      { url: 'https://essays.example/plaques', text: 'plaques' },
      { url: 'https://img.example/x', text: 'a picture' },
      { url: 'https://papers.example/paper.pdf', text: 'a paper' },
    ]);
  });

  it('leaves out mail, jumps, scripts and the article itself', () => {
    const doc = parse(`
      <a href="mailto:a@b.example">mail</a>
      <a href="#fn1">1</a>
      <a href="${ARTICLE}#fn2">2</a>
      <a href="javascript:void(0)">js</a>
      <a href="${ARTICLE}/">self</a>
      <a href="http://www.essays.example/how-cities-remember">self over http</a>
      <a href="https://kept.example/">kept</a>`);
    expect(articleLinks(doc, ARTICLE).map((l) => l.text)).toEqual(['kept']);
  });

  it('works without a usable article address, for absolute links', () => {
    const doc = parse('<a href="/relative">r</a><a href="https://abs.example/a">a</a>');
    expect(articleLinks(doc, null).map((l) => l.url)).toEqual(['https://abs.example/a']);
    // A document known only by its path.
    expect(articleLinks(doc, '/my-post').map((l) => l.url)).toEqual(['https://abs.example/a']);
  });
});

describe('linkTitleHint', () => {
  it('takes words, not bare links or short words', () => {
    expect(linkTitleHint('  rivers paved over long ago ')).toBe('rivers paved over long ago');
    expect(linkTitleHint('here')).toBeUndefined();
    expect(linkTitleHint('https://x.example/a-long-path')).toBeUndefined();
    expect(linkTitleHint('www.example.com/long')).toBeUndefined();
  });
});
