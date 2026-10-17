/**
 * Ties a saved YouTube video's transcript to its player.
 *
 * Defuddle's YouTube extractor writes the player followed by a transcript whose
 * lines read `<p><strong>1:23</strong> · words…</p>`. Its own attribute pass strips
 * the `data-timestamp` and classes it put there, so the visible time is all that
 * survives into a save; it is parsed back out here, which also covers every video
 * saved before this existed.
 *
 * Three things, all driven through the embed's postMessage API (the same protocol
 * YouTube's iframe_api script speaks, without loading that script):
 *   - a timestamp is a control: activating it seeks the player there and plays;
 *   - while the video plays, the line being spoken is marked, and the transcript
 *     scrolls along with it as long as the reader is following it (their line is
 *     on screen), never pulling them back once they've scrolled away;
 *   - with `pin`, the player sticks to the top of the reader once it's playing,
 *     so the transcript can be read beneath it.
 */

export interface VideoTranscriptOptions {
  /** Stick the player to the top while it plays. Off where the body doesn't scroll
   *  as one column (paged reading) or sits in a list (feed cards). */
  pin?: boolean;
  /** Scroll the transcript along with playback. Off in paged reading. */
  follow?: boolean;
}

interface TranscriptLine {
  line: HTMLElement;
  stamp: HTMLElement;
  start: number;
}

interface Transcript {
  iframe: HTMLIFrameElement;
  lines: TranscriptLine[];
}

const PLAYER_ORIGINS = new Set([
  'https://www.youtube.com',
  'https://youtube.com',
  'https://www.youtube-nocookie.com',
  'https://youtube-nocookie.com',
]);

// Two lines is the least that reads as a transcript rather than a paragraph that
// happens to open with a bold time.
const MIN_LINES = 2;

const TIMESTAMP = /^(?:(\d+):)?(\d{1,2}):(\d{2})$/;

/** `1:23` → 83, `1:02:03` → 3723; null for anything that isn't a time. */
export function parseTimestamp(text: string): number | null {
  const match = TIMESTAMP.exec(text.trim());
  if (!match) return null;
  const [, h, m, s] = match;
  return (h ? Number(h) * 3600 : 0) + Number(m) * 60 + Number(s);
}

function isYouTubePlayer(iframe: HTMLIFrameElement): boolean {
  try {
    const url = new URL(iframe.src);
    return PLAYER_ORIGINS.has(url.origin) && url.pathname.startsWith('/embed/');
  } catch {
    return false;
  }
}

/** The line's leading `<strong>` time, when the line is a transcript line. */
function lineStamp(p: HTMLElement): { stamp: HTMLElement; start: number } | null {
  const first = p.firstElementChild;
  if (!first || (first.tagName !== 'STRONG' && first.tagName !== 'B')) return null;
  // Nothing but whitespace may come before the time.
  for (let node = p.firstChild; node && node !== first; node = node.nextSibling) {
    if (node.nodeType !== Node.TEXT_NODE || node.textContent?.trim()) return null;
  }
  const stampText = first.textContent ?? '';
  const start = parseTimestamp(stampText);
  if (start === null) return null;
  // `<strong>1:23</strong> · words` — read through textContent so a highlight
  // wrapping the separator doesn't hide it.
  const rest = (p.textContent ?? '').trimStart().slice(stampText.trim().length);
  if (!/^\s*·/.test(rest)) return null;
  return { stamp: first as HTMLElement, start };
}

/** Find a YouTube player and the transcript that follows it under `root`. */
export function findTranscript(root: ParentNode): Transcript | null {
  // Most bodies carry no player; skip the paragraph scan (it re-runs on every DOM
  // mutation, e.g. each highlight) unless there's an iframe to wire to.
  if (!root.querySelector('iframe')) return null;
  const lines: TranscriptLine[] = [];
  for (const p of root.querySelectorAll<HTMLElement>('p')) {
    const found = lineStamp(p);
    if (!found) continue;
    // Times only run forward; a line that goes back is something else.
    if (lines.length && found.start < lines[lines.length - 1].start) continue;
    lines.push({ line: p, ...found });
  }
  if (lines.length < MIN_LINES) return null;

  // The player is the last YouTube embed before the transcript begins.
  let iframe: HTMLIFrameElement | null = null;
  for (const candidate of root.querySelectorAll<HTMLIFrameElement>('iframe')) {
    if (!(candidate.compareDocumentPosition(lines[0].line) & Node.DOCUMENT_POSITION_FOLLOWING)) {
      break;
    }
    if (isYouTubePlayer(candidate)) iframe = candidate;
  }
  return iframe ? { iframe, lines } : null;
}

/** The last line starting at or before `time`; null before the first. */
export function lineAt(lines: TranscriptLine[], time: number): TranscriptLine | null {
  let lo = 0;
  let hi = lines.length - 1;
  let found: TranscriptLine | null = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (lines[mid].start <= time) {
      found = lines[mid];
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found;
}

interface PlayerInfo {
  currentTime?: number;
  playerState?: number;
}

// YT.PlayerState values the embed reports.
const ENDED = 0;
const PLAYING = 1;

// The embed answers a `listening` message once its player has booted; until then
// the handshake is repeated, as YouTube's own iframe_api does.
const HANDSHAKE_INTERVAL_MS = 250;
const HANDSHAKE_TRIES = 40;

/** The embed's postMessage API: send commands, hear back time and state. */
class PlayerBridge {
  private origin: string | null = null;
  private queue: Array<[string, unknown[]]> = [];
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(
    readonly iframe: HTMLIFrameElement,
    private readonly onInfo: (info: PlayerInfo) => void
  ) {
    window.addEventListener('message', this.onMessage);
    iframe.addEventListener('load', this.handshake);
    this.handshake();
  }

  command(func: string, args: unknown[] = []): void {
    if (this.origin) {
      this.post({ event: 'command', func, args }, this.origin);
    } else {
      this.queue.push([func, args]);
      // A lazy embed below the fold hasn't loaded at all; a command means the
      // reader wants it now.
      if (this.iframe.loading === 'lazy') this.iframe.loading = 'eager';
      this.handshake();
    }
  }

  destroy(): void {
    clearInterval(this.timer);
    window.removeEventListener('message', this.onMessage);
    this.iframe.removeEventListener('load', this.handshake);
  }

  private handshake = (): void => {
    clearInterval(this.timer);
    let tries = 0;
    const knock = () => {
      if (this.origin || ++tries > HANDSHAKE_TRIES) {
        clearInterval(this.timer);
        return;
      }
      // `*` because the frame may still be about:blank (a lazy embed not yet
      // loaded), which an exact origin would refuse with a console error. The
      // message is only a request to be told the player's state; commands go to
      // the origin the player answered from.
      this.post({ event: 'listening' }, '*');
    };
    knock();
    this.timer = setInterval(knock, HANDSHAKE_INTERVAL_MS);
  };

  private post(message: Record<string, unknown>, targetOrigin: string): void {
    this.iframe.contentWindow?.postMessage(
      JSON.stringify({ ...message, id: 1, channel: 'widget' }),
      targetOrigin
    );
  }

  private onMessage = (event: MessageEvent): void => {
    if (event.source !== this.iframe.contentWindow || !PLAYER_ORIGINS.has(event.origin)) return;
    let data: { event?: string; info?: PlayerInfo } | null = null;
    try {
      data = typeof event.data === 'string' ? JSON.parse(event.data) : event.data;
    } catch {
      return;
    }
    if (!data || typeof data !== 'object') return;

    if (!this.origin) {
      this.origin = event.origin;
      clearInterval(this.timer);
      for (const [func, args] of this.queue.splice(0)) this.command(func, args);
    }
    if (data.info && typeof data.info === 'object') this.onInfo(data.info);
  };
}

function scrollParent(node: HTMLElement): HTMLElement | null {
  for (let el = node.parentElement; el; el = el.parentElement) {
    const { overflowY } = getComputedStyle(el);
    if ((overflowY === 'auto' || overflowY === 'scroll') && el.scrollHeight > el.clientHeight) {
      return el;
    }
  }
  return null;
}

/** Svelte action: wire the transcript under `node` to its player. */
export function videoTranscript(node: HTMLElement, options: VideoTranscriptOptions = {}) {
  let opts = options;
  let transcript: Transcript | null = null;
  let bridge: PlayerBridge | null = null;
  const stamps = new WeakMap<HTMLElement, TranscriptLine>();
  let current: TranscriptLine | null = null;
  let started = false;
  let playing = false;

  const reduceMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

  function setPinned(on: boolean) {
    transcript?.iframe.classList.toggle('video-pinned', on && !!opts.pin);
  }

  /** The part of the scroller the transcript can be read in: below a pinned
   *  player, above the bottom edge. */
  function readableBand(scroller: HTMLElement | null): { top: number; bottom: number } {
    const box = scroller?.getBoundingClientRect() ?? { top: 0, bottom: window.innerHeight };
    let top = box.top;
    const iframe = transcript?.iframe;
    if (iframe?.classList.contains('video-pinned')) {
      top = Math.max(top, iframe.getBoundingClientRect().bottom);
    }
    return { top, bottom: Math.min(box.bottom, window.innerHeight) };
  }

  function setCurrent(next: TranscriptLine | null) {
    if (next === current) return;
    const previous = current;
    previous?.line.classList.remove('is-current');
    next?.line.classList.add('is-current');
    current = next;
    if (!next || !opts.follow || !playing) return;

    const scroller = scrollParent(node);
    const band = readableBand(scroller);
    // Follow only a reader who is following: the line they were on is on screen.
    if (previous) {
      const was = previous.line.getBoundingClientRect();
      if (was.bottom <= band.top || was.top >= band.bottom) return;
    }
    const rect = next.line.getBoundingClientRect();
    const height = band.bottom - band.top;
    if (rect.top >= band.top && rect.bottom <= band.bottom - height * 0.15) return;
    const delta = rect.top - (band.top + height * 0.2);
    const behavior: ScrollBehavior = reduceMotion() ? 'auto' : 'smooth';
    (scroller ?? window).scrollBy({ top: delta, behavior });
  }

  function onInfo(info: PlayerInfo) {
    if (!transcript) return;
    if (typeof info.playerState === 'number') {
      playing = info.playerState === PLAYING;
      if (playing) {
        started = true;
        setPinned(true);
      } else if (info.playerState === ENDED) {
        started = false;
        setPinned(false);
        setCurrent(null);
      }
    }
    if (started && typeof info.currentTime === 'number') {
      setCurrent(lineAt(transcript.lines, info.currentTime));
    }
  }

  function seek(line: TranscriptLine) {
    if (!bridge) return;
    bridge.command('seekTo', [line.start, true]);
    bridge.command('playVideo');
    started = true;
    setPinned(true);
    // Mark it now rather than on the player's next report, so the click lands.
    setCurrent(line);
  }

  function hydrate() {
    const found = findTranscript(node);
    if (!found) {
      teardown();
      return;
    }
    if (found.iframe !== bridge?.iframe) {
      teardown();
      bridge = new PlayerBridge(found.iframe, onInfo);
    }
    transcript = found;
    for (const entry of found.lines) {
      stamps.set(entry.stamp, entry);
      entry.line.classList.add('transcript-line');
      if (entry.stamp.classList.contains('transcript-time')) continue;
      const label = `Play from ${entry.stamp.textContent?.trim()}`;
      entry.stamp.classList.add('transcript-time');
      entry.stamp.setAttribute('role', 'button');
      entry.stamp.setAttribute('tabindex', '0');
      entry.stamp.setAttribute('aria-label', label);
      entry.stamp.setAttribute('title', label);
    }
    if (current && !found.lines.includes(current)) current = null;
    setPinned(started);
  }

  function teardown() {
    bridge?.destroy();
    bridge = null;
    transcript = null;
    current = null;
    started = false;
    playing = false;
  }

  function stampFrom(event: Event): TranscriptLine | null {
    const el = (event.target as Element | null)?.closest?.('.transcript-time');
    return el instanceof HTMLElement && node.contains(el) ? (stamps.get(el) ?? null) : null;
  }

  function onClick(event: MouseEvent) {
    const line = stampFrom(event);
    if (!line) return;
    // A drag that ends on a time is a selection to highlight, not a seek.
    const selection = window.getSelection();
    if (selection && !selection.isCollapsed && selection.toString().trim()) return;
    event.preventDefault();
    // The card behind a feed item treats a body tap as open/close.
    event.stopPropagation();
    seek(line);
  }

  function onKeydown(event: KeyboardEvent) {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    const line = stampFrom(event);
    if (!line) return;
    event.preventDefault();
    event.stopPropagation();
    seek(line);
  }

  node.addEventListener('click', onClick);
  node.addEventListener('keydown', onKeydown);

  // Re-scan when the body is replaced (another article) or a highlight splits a
  // line; batched, since a highlight can touch many nodes at once.
  let queued = false;
  const observer = new MutationObserver(() => {
    if (queued) return;
    queued = true;
    queueMicrotask(() => {
      queued = false;
      hydrate();
    });
  });
  observer.observe(node, { childList: true, subtree: true });
  hydrate();

  return {
    update(next: VideoTranscriptOptions = {}) {
      opts = next;
      setPinned(started);
    },
    destroy() {
      observer.disconnect();
      node.removeEventListener('click', onClick);
      node.removeEventListener('keydown', onKeydown);
      teardown();
    },
  };
}
