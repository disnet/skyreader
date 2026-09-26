import { describe, it, expect } from 'vitest';
import { htmlLead } from '../src/utils/html-lead';

const bytes = (s: string) => new TextEncoder().encode(s).length;

describe('htmlLead', () => {
  it('returns a body that fits unchanged', () => {
    expect(htmlLead('<p>short</p>', 100)).toBe('<p>short</p>');
  });

  it('cuts after the last top-level element that fits', () => {
    const para = (n: number) => `<p>Paragraph ${n} ${'word '.repeat(30)}</p>`;
    const html = Array.from({ length: 40 }, (_, n) => para(n)).join('\n');
    const lead = htmlLead(html, 1024)!;
    expect(bytes(lead)).toBeLessThanOrEqual(1024);
    expect(lead.endsWith('</p>')).toBe(true);
    expect(html.startsWith(lead)).toBe(true);
    // As many whole paragraphs as fit, not just the first.
    const kept = lead.split('</p>').length - 1;
    expect(kept).toBeGreaterThan(1);
    expect(bytes(`${lead}\n${para(kept)}`)).toBeGreaterThan(1024);
  });

  it('falls back to a closing block inside one big wrapper', () => {
    const html = `<div class="body">${'<p>A paragraph of the post body.</p>'.repeat(200)}</div>`;
    const lead = htmlLead(html, 1024)!;
    expect(bytes(lead)).toBeLessThanOrEqual(1024);
    expect(lead.startsWith('<div class="body"><p>')).toBe(true);
    expect(lead.endsWith('</p>')).toBe(true);
  });

  it('cuts one long paragraph at a word boundary, never inside a tag or entity', () => {
    const html = `<p>${'caf&eacute; <a href="https://x.example/a>b">link</a> '.repeat(300)}</p>`;
    const lead = htmlLead(html, 700)!;
    expect(bytes(lead)).toBeLessThanOrEqual(700);
    expect(lead).not.toMatch(/&[a-z]*$/i);
    // Every `<` that opens a tag in the lead is closed by a `>`.
    expect(lead.lastIndexOf('<')).toBeLessThan(lead.lastIndexOf('>'));
  });

  it('counts bytes, not code units', () => {
    const html = `<p>${'日本語の文章です。'.repeat(20)}</p>`.repeat(20);
    const lead = htmlLead(html, 1000)!;
    expect(bytes(lead)).toBeLessThanOrEqual(1000);
    expect(lead.endsWith('</p>')).toBe(true);
  });

  it('does not read markup inside a script as tags', () => {
    const html =
      `<p>${'intro '.repeat(50)}</p><script>if (a < b) { x = "</p>"; }</script>` +
      `<p>${'rest '.repeat(400)}</p>`;
    const lead = htmlLead(html, 700)!;
    // The cut lands after the script or before it — never inside it.
    const opens = (lead.match(/<script/g) ?? []).length;
    const closes = (lead.match(/<\/script>/g) ?? []).length;
    expect(opens).toBe(closes);
  });

  it('keeps void and self-closed elements from unbalancing the depth', () => {
    const figure = '<figure><img src="a.jpg"><br/><figcaption>cap</figcaption></figure>';
    const html = Array.from({ length: 50 }, () => `${figure}<p>${'text '.repeat(20)}</p>`).join('');
    const lead = htmlLead(html, 1500)!;
    expect(lead.endsWith('</p>') || lead.endsWith('</figure>')).toBe(true);
  });

  it('returns undefined when the prefix has no visible text', () => {
    const html = `<img src="${'x'.repeat(5000)}">`;
    expect(htmlLead(html, 1024)).toBeUndefined();
    expect(htmlLead('x'.repeat(5000), 1024)).toBeUndefined();
  });
});
