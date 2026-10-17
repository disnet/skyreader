import { afterEach, describe, expect, it } from 'vitest';
import { imageLightbox } from './image-lightbox';
import { lightbox } from '$lib/stores/lightbox.svelte';

function mount(html: string, options?: { enabled?: boolean }) {
  const host = document.createElement('div');
  host.innerHTML = html;
  document.body.append(host);
  // jsdom lays nothing out; give every image a picture-sized box.
  for (const img of host.querySelectorAll('img')) {
    img.getBoundingClientRect = () => ({ width: 400, height: 300 }) as DOMRect;
  }
  const action = imageLightbox(host, options);
  return { host, action };
}

function click(el: Element) {
  const e = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 });
  el.dispatchEvent(e);
  return e;
}

afterEach(() => {
  lightbox.close();
  document.body.innerHTML = '';
});

describe('imageLightbox', () => {
  it('opens a clicked image with its alt text', () => {
    const { host } = mount('<p><img src="https://example.com/a.jpg" alt="A cat"></p>');
    const e = click(host.querySelector('img')!);
    expect(lightbox.current).toEqual({ src: 'https://example.com/a.jpg', alt: 'A cat' });
    expect(e.defaultPrevented).toBe(true);
  });

  it('opens the full-size file an image links to', () => {
    const { host } = mount(
      '<a href="https://example.com/full.png"><img src="https://example.com/thumb.png"></a>'
    );
    click(host.querySelector('img')!);
    expect(lightbox.current?.src).toBe('https://example.com/full.png');
  });

  it('lets an image that links to a page follow its link', () => {
    const { host } = mount(
      '<a href="https://example.com/post"><img src="https://example.com/a.jpg"></a>'
    );
    const e = click(host.querySelector('img')!);
    expect(lightbox.current).toBeNull();
    expect(e.defaultPrevented).toBe(false);
  });

  it('leaves icons and emoji alone', () => {
    const { host } = mount('<img src="https://example.com/emoji.png">');
    const img = host.querySelector('img')!;
    img.getBoundingClientRect = () => ({ width: 20, height: 20 }) as DOMRect;
    click(img);
    expect(lightbox.current).toBeNull();
  });

  it('does nothing while disabled, and resumes when re-enabled', () => {
    const { host, action } = mount('<img src="https://example.com/a.jpg">', { enabled: false });
    click(host.querySelector('img')!);
    expect(lightbox.current).toBeNull();
    action.update({ enabled: true });
    click(host.querySelector('img')!);
    expect(lightbox.current?.src).toBe('https://example.com/a.jpg');
  });
});
