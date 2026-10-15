/**
 * Fine-grained reactivity for a keyed collection that lives in plain Maps.
 *
 * A store that re-assigns its whole Map to signal a change invalidates every
 * reader of every key: marking one article read re-ran `isRead` for every card
 * on screen. `SvelteMap` doesn't help for this shape, because a lookup of a key
 * that ISN'T in the map (an unread item has no `read` label) tracks the map's
 * version, which bumps on every insert.
 *
 * Instead, readers `track(key)` and writers `bump(key)` a signal for the key.
 * Keys hash into a fixed set of buckets, all created up front: a `$state`
 * created lazily inside a `$derived` is not tracked by that derived, so the
 * signals can't be made on first read. A bump re-runs the readers of one bucket
 * (a key's neighbours included), never the whole list.
 */

class Signal {
  v = $state(0);
}

export class KeyedSignals {
  #buckets: Signal[];

  constructor(size: number) {
    this.#buckets = Array.from({ length: size }, () => new Signal());
  }

  #bucket(key: string): Signal {
    // FNV-1a: cheap, and spreads the shared prefixes of URLs and at:// URIs.
    let h = 0x811c9dc5;
    for (let i = 0; i < key.length; i++) {
      h ^= key.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return this.#buckets[(h >>> 0) % this.#buckets.length];
  }

  /** Make the current reaction depend on `key`. */
  track(key: string): void {
    void this.#bucket(key).v;
  }

  /** Make the current reaction depend on every key. */
  trackAll(): void {
    for (const b of this.#buckets) void b.v;
  }

  /** Re-run the readers of `key`. */
  bump(key: string): void {
    this.#bucket(key).v++;
  }

  /** Re-run every reader (the backing data was replaced wholesale). */
  bumpAll(): void {
    for (const b of this.#buckets) b.v++;
  }
}
