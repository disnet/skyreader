/// <reference types="vite-plugin-pwa/svelte" />

// See https://svelte.dev/docs/kit/types#app.d.ts
// for information about these interfaces
declare global {
  namespace App {
    // interface Error {}
    // interface Locals {}
    // interface PageData {}
    interface PageState {
      // Reader-stack depth (every surface that opens the fullscreen reader): each
      // open pushes a history entry; Back regresses the depth, popping the stack
      // to match. The entry's URL carries the open item's key as `?read=`, so a
      // cold load (where no state exists) can restore the same reader from the URL
      // alone. See `useReaderStack` for the full contract.
      readerDepth?: number;
    }
    // interface Platform {}
  }
}

export {};
