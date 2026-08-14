// Ambient types for the slice of `node:async_hooks` that workerd exposes under
// the `nodejs_als` compatibility flag (see wrangler.toml).
//
// Why not `@types/node`: it would declare Node's entire global surface — process,
// Buffer, NodeJS.Timeout — inside a Workers project that deliberately doesn't
// have it, quietly type-checking code that would fail at runtime. `AsyncLocalStorage`
// is the only Node API this Worker uses, so it's the only one declared.
declare module 'node:async_hooks' {
  export class AsyncLocalStorage<T> {
    run<R>(store: T, callback: () => R): R;
    getStore(): T | undefined;
    enterWith(store: T): void;
    exit<R>(callback: () => R): R;
  }
}
