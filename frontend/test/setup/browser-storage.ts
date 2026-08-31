// Node 26 ships its own `localStorage` global that stays undefined unless the
// process was started with --localstorage-file, and it shadows the one jsdom
// installs — so inside the component project both `globalThis.localStorage` and
// `window.localStorage` are undefined.
//
// That is fatal rather than merely inconvenient: stores like `auth.svelte.ts`
// read storage at module-init time to restore the cached user, so a component
// that imports one (anything rendering <LimitNotice>, for instance) throws
// during import and the whole suite collects zero tests. An in-memory Storage
// keeps those imports alive; it starts empty for every file, which is what a
// test wants anyway.

class MemoryStorage implements Storage {
  #entries = new Map<string, string>();

  get length(): number {
    return this.#entries.size;
  }

  clear(): void {
    this.#entries.clear();
  }

  getItem(key: string): string | null {
    return this.#entries.get(String(key)) ?? null;
  }

  key(index: number): string | null {
    return [...this.#entries.keys()][index] ?? null;
  }

  removeItem(key: string): void {
    this.#entries.delete(String(key));
  }

  setItem(key: string, value: string): void {
    this.#entries.set(String(key), String(value));
  }
}

for (const name of ['localStorage', 'sessionStorage'] as const) {
  const storage = new MemoryStorage();
  for (const host of [globalThis, typeof window === 'undefined' ? null : window]) {
    if (!host) continue;
    Object.defineProperty(host, name, {
      value: storage,
      configurable: true,
      writable: true,
    });
  }
}
