// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { findTranscript, lineAt, parseTimestamp, videoTranscript } from './video-transcript';
import { sanitizeHtml } from '$lib/utils/sanitize';

// What a saved YouTube video's body looks like: Defuddle's YouTube extractor
// output after its attribute pass, which strips the transcript's classes and
// `data-timestamp` and leaves the visible time.
const SAVED_VIDEO = `<iframe width="560" height="315" src="https://www.youtube.com/embed/abc" frameborder="0" allowfullscreen></iframe><p>Description, with <strong>bold</strong> words.</p><div>
<h2>Transcript</h2>
<h3>Intro</h3>
<p><strong><span>0:00</span></strong> · Hello there.</p>
<p><strong><span>1:23</span></strong> · Second bit.</p>
<h3>Later</h3>
<p><strong><span>1:02:03</span></strong> · Much later.</p>
</div>`;

function mount(html = SAVED_VIDEO): HTMLElement {
  const host = document.createElement('div');
  host.innerHTML = sanitizeHtml(html, 'https://www.youtube.com/watch?v=abc');
  document.body.append(host);
  return host;
}

afterEach(() => {
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

describe('parseTimestamp', () => {
  it('reads m:ss and h:mm:ss', () => {
    expect(parseTimestamp('0:00')).toBe(0);
    expect(parseTimestamp(' 1:23 ')).toBe(83);
    expect(parseTimestamp('1:02:03')).toBe(3723);
  });

  it('refuses anything else', () => {
    expect(parseTimestamp('Note:')).toBeNull();
    expect(parseTimestamp('1:2')).toBeNull();
    expect(parseTimestamp('12')).toBeNull();
  });
});

describe('findTranscript', () => {
  it('finds the player and each line of a saved video, through the sanitizer', () => {
    const found = findTranscript(mount());
    expect(found?.iframe.src).toContain('youtube.com/embed/abc');
    expect(found?.lines.map((l) => l.start)).toEqual([0, 83, 3723]);
  });

  it('opens the embed to the reader’s controls', () => {
    const iframe = mount().querySelector('iframe')!;
    expect(new URL(iframe.src).searchParams.get('enablejsapi')).toBe('1');
    expect(iframe.getAttribute('allow')).toContain('autoplay');
  });

  it('needs a YouTube player before the transcript', () => {
    expect(findTranscript(mount(SAVED_VIDEO.replace(/<iframe.*?<\/iframe>/, '')))).toBeNull();
  });

  it('ignores an article that only opens a paragraph with a bold time', () => {
    const html = `<iframe src="https://www.youtube.com/embed/abc"></iframe>
      <p><strong>9:30</strong> · Doors open.</p><p>Then the talk.</p>`;
    expect(findTranscript(mount(html))).toBeNull();
  });
});

describe('lineAt', () => {
  it('picks the last line started', () => {
    const lines = findTranscript(mount())!.lines;
    expect(lineAt(lines, 0)?.start).toBe(0);
    expect(lineAt(lines, 82.9)?.start).toBe(0);
    expect(lineAt(lines, 600)?.start).toBe(83);
    expect(lineAt(lines, 4000)?.start).toBe(3723);
  });
});

describe('videoTranscript', () => {
  function setup(options = { pin: true, follow: false }) {
    const host = mount();
    const iframe = host.querySelector('iframe')!;
    const player = iframe.contentWindow!;
    const posted = vi.spyOn(player, 'postMessage');
    const action = videoTranscript(host, options);
    const reply = (info: Record<string, unknown>) =>
      window.dispatchEvent(
        new MessageEvent('message', {
          data: JSON.stringify({ event: 'infoDelivery', info }),
          origin: 'https://www.youtube.com',
          source: player,
        })
      );
    const commands = () =>
      posted.mock.calls
        .map(([data, target]) => ({ ...JSON.parse(data as string), target }))
        .filter((m) => m.event === 'command');
    const stamp = (text: string) =>
      [...host.querySelectorAll<HTMLElement>('.transcript-time')].find(
        (el) => el.textContent === text
      )!;
    return { host, iframe, action, reply, commands, stamp };
  }

  it('makes each time a labelled control', () => {
    const { stamp, action } = setup();
    const el = stamp('1:23');
    expect(el.getAttribute('role')).toBe('button');
    expect(el.getAttribute('tabindex')).toBe('0');
    expect(el.getAttribute('aria-label')).toBe('Play from 1:23');
    action.destroy();
  });

  it('seeks and plays once the player answers, marking the line and pinning the player', () => {
    const { iframe, host, action, reply, commands, stamp } = setup();
    stamp('1:23').click();
    // Nothing goes to a player that hasn't booted yet...
    expect(commands()).toEqual([]);
    expect(host.querySelector('.is-current')?.textContent).toContain('Second bit');
    expect(iframe.classList.contains('video-pinned')).toBe(true);

    // ...and the queue drains to the origin it answered from.
    reply({ playerState: -1 });
    expect(commands()).toEqual([
      expect.objectContaining({
        func: 'seekTo',
        args: [83, true],
        target: 'https://www.youtube.com',
      }),
      expect.objectContaining({ func: 'playVideo', target: 'https://www.youtube.com' }),
    ]);
    action.destroy();
  });

  it('follows playback, and lets go when the video ends', () => {
    const { iframe, host, action, reply } = setup();
    reply({ playerState: 1, currentTime: 3800 });
    expect(host.querySelector('.is-current')?.textContent).toContain('Much later');
    expect(iframe.classList.contains('video-pinned')).toBe(true);

    reply({ playerState: 0 });
    expect(host.querySelector('.is-current')).toBeNull();
    expect(iframe.classList.contains('video-pinned')).toBe(false);
    action.destroy();
  });

  it('does not mark a line before the video has played', () => {
    const { host, action, reply } = setup();
    reply({ playerState: 5, currentTime: 0 });
    expect(host.querySelector('.is-current')).toBeNull();
    action.destroy();
  });

  it('ignores messages from anything but the player', () => {
    const { host, action } = setup();
    window.dispatchEvent(
      new MessageEvent('message', {
        data: JSON.stringify({ event: 'infoDelivery', info: { playerState: 1, currentTime: 90 } }),
        origin: 'https://evil.example',
        source: window,
      })
    );
    expect(host.querySelector('.is-current')).toBeNull();
    action.destroy();
  });

  it('never pins where pinning is off', () => {
    const { iframe, action, reply } = setup({ pin: false, follow: false });
    reply({ playerState: 1, currentTime: 10 });
    expect(iframe.classList.contains('video-pinned')).toBe(false);
    action.destroy();
  });

  it('leaves a drag-select that ends on a time alone', () => {
    const { host, action, stamp } = setup();
    const range = document.createRange();
    range.selectNodeContents(host.querySelector('h2')!);
    window.getSelection()!.addRange(range);
    stamp('1:23').click();
    expect(host.querySelector('.is-current')).toBeNull();
    action.destroy();
  });
});
